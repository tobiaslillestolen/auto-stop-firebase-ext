import { createRequest, getMonitoringClient } from "./cloudMonitoring.js";
import { log } from "firebase-functions/logger";
import moment from "moment-timezone";
import getPrice from "./getPrice.js";

// NOTE: About Firestore Editions
// The pricing models are different for Standard edition
// and Enterprise edition. Enterprise pricing metrics are only
// available for the Enterprise edition databases, so we fetch
// those first - and take note of which database IDs are Enterprise.
// The standard edition metrics (like number of reads) are
// available for both types, but we can simply skip any databases
// which we earlier identified as Enterprise.

const DEFAULT_COST_STANDARD_READ = 0.3; // USD per million reads
const DEFAULT_COST_STANDARD_WRITE = 0.9; // USD per million writes
const DEFAULT_COST_STANDARD_DELETE = 0.1; // USD per million deletes
const DEFAULT_COST_ENTERPRISE_READ_UNIT = 0.05; // USD per million read units
const DEFAULT_COST_ENTERPRISE_WRITE_UNIT = 0.26; // USD per million write units

const FREE_TIER_ENTERPRISE_DAILY_READ_UNITS = 50000;
const FREE_TIER_ENTERPRISE_DAILY_WRITE_UNITS = 40000;
const FREE_TIER_STANDARD_DAILY_READS = 50000;
const FREE_TIER_STANDARD_DAILY_WRITES = 20000;
const FREE_TIER_STANDARD_DAILY_DELETES = 20000;

export const getFirestoreCost = async (projectId, startOfMonthTs) => {
  const monitoringClient = getMonitoringClient();
  const freeTierDatabaseId = process.env.FIRESTORE_FREE_TIER_DATABASE_NAME;

  const enterpriseReadsRequest = createRequest(
    projectId,
    startOfMonthTs,
    "firestore.googleapis.com/api/billable_read_units",
  );
  const enterpriseReadsRequestPrm = monitoringClient.listTimeSeries(
    enterpriseReadsRequest,
  );

  // Enterprise uses write units for both writes and deletes
  const enterpriseWritesRequest = createRequest(
    projectId,
    startOfMonthTs,
    "firestore.googleapis.com/api/billable_write_units",
  );
  const enterpriseWritesRequestPrm = monitoringClient.listTimeSeries(
    enterpriseWritesRequest,
  );

  // NOTE: There seems to be a bug in the monitoring API where the
  // supposed required /Database/ part of the metric type must be
  // omitted for the request to succeed. I submitted an issue on this:
  // https://issuetracker.google.com/issues/449423585

  const standardReadsRequest = createRequest(
    projectId,
    startOfMonthTs,
    "firestore.googleapis.com/document/read_ops_count",
  );
  const standardReadsRequestPrm =
    monitoringClient.listTimeSeries(standardReadsRequest);

  const standardWritesRequest = createRequest(
    projectId,
    startOfMonthTs,
    "firestore.googleapis.com/document/write_ops_count",
  );
  const standardWritesRequestPrm = monitoringClient.listTimeSeries(
    standardWritesRequest,
  );

  const standardDeletesRequest = createRequest(
    projectId,
    startOfMonthTs,
    "firestore.googleapis.com/document/delete_ops_count",
  );
  const standardDeletesRequestPrm = monitoringClient.listTimeSeries(
    standardDeletesRequest,
  );

  const [enterpriseReadsData, enterpriseWritesData] = await Promise.all([
    enterpriseReadsRequestPrm,
    enterpriseWritesRequestPrm,
  ]);

  // To avoid creating potentially hundreds of thousands of
  // moment objects we create one in the correct timezone,
  // and just mutate it for each point. Slightly faster
  // and much less garbage collection.
  const pointMoment = moment().millisecond(0).tz("America/Los_Angeles");
  const getDateByUnixTs = (unixTs) => {
    const diff = unixTs - pointMoment.unix();
    pointMoment.add(diff, "seconds");
    return pointMoment.date().toString(); // 1-31
  };

  const enterpriseDatabaseIds = new Set();
  const calculatePaidOperations = (db, isEnterpriseRequest, freeQuota) => {
    let result = 0;
    const databaseId = db.resource.labels.database_id;

    if (isEnterpriseRequest) {
      // Enterprise request - mark this db as enterprise
      enterpriseDatabaseIds.add(databaseId);
    } else {
      // Standard request - skip enterprise dbs
      if (enterpriseDatabaseIds.has(databaseId)) return 0;
    }

    const isFreeTierDb = databaseId === freeTierDatabaseId;
    const perDay = isFreeTierDb ? {} : undefined;

    db.points.forEach((point) => {
      if (point.value.int64Value === "0") return;
      const operations = parseInt(point.value.int64Value, 10);

      if (!isFreeTierDb) {
        result += operations;
        return;
      }

      const key = getDateByUnixTs(point.interval.startTime.seconds);
      if (!perDay[key]) {
        perDay[key] = 0;
      }
      perDay[key] += operations;
    });

    if (isFreeTierDb) {
      Object.values(perDay).forEach((dailyUsage) => {
        result += Math.max(0, dailyUsage - freeQuota);
      });
    }

    const labelName =
      db.metric.labels.type ||
      db.metric.labels.api_method ||
      db.metric.labels.op ||
      "unknown";
    log(`  Firestore DB ${databaseId} Paid ${labelName}-operations: ${result}`);
    return result;
  };

  log("Firestore Enterprise Edition Usage:");

  let entReadUnits = 0;
  enterpriseReadsData[0].forEach((db) => {
    entReadUnits += calculatePaidOperations(
      db,
      true,
      FREE_TIER_ENTERPRISE_DAILY_READ_UNITS,
    );
  });

  let entWriteUnits = 0;
  enterpriseWritesData[0].forEach((db) => {
    entWriteUnits += calculatePaidOperations(
      db,
      true,
      FREE_TIER_ENTERPRISE_DAILY_WRITE_UNITS,
    );
  });

  // Here we need standard data

  const [standardReadsData, standardWritesData, standardDeletesData] =
    await Promise.all([
      standardReadsRequestPrm,
      standardWritesRequestPrm,
      standardDeletesRequestPrm,
    ]);

  log("Firestore Standard Edition Usage:");

  let stdReads = 0;
  standardReadsData[0].forEach((db) => {
    stdReads += calculatePaidOperations(
      db,
      false,
      FREE_TIER_STANDARD_DAILY_READS,
    );
  });

  let stdWrites = 0;
  standardWritesData[0].forEach((db) => {
    stdWrites += calculatePaidOperations(
      db,
      false,
      FREE_TIER_STANDARD_DAILY_WRITES,
    );
  });

  let stdDeletes = 0;
  standardDeletesData[0].forEach((db) => {
    stdDeletes += calculatePaidOperations(
      db,
      false,
      FREE_TIER_STANDARD_DAILY_DELETES,
    );
  });

  const entReadUnitCost = getPrice(
    "Firebase Enterprise Read Unit",
    process.env.MONITOR_FIRESTORE_ENT_READ_UNIT_COST,
    DEFAULT_COST_ENTERPRISE_READ_UNIT,
    0.01,
    5.0,
  );

  const entWriteUnitCost = getPrice(
    "Enterprise Write Unit",
    process.env.MONITOR_FIRESTORE_ENT_WRITE_UNIT_COST,
    DEFAULT_COST_ENTERPRISE_WRITE_UNIT,
    0.01,
    5.0,
  );

  const stdReadCost = getPrice(
    "Standard Read",
    process.env.MONITOR_FIRESTORE_STD_READ_COST,
    DEFAULT_COST_STANDARD_READ,
    0.01,
    5.0,
  );

  const stdWriteCost = getPrice(
    "Standard Write",
    process.env.MONITOR_FIRESTORE_STD_WRITE_COST,
    DEFAULT_COST_STANDARD_WRITE,
    0.01,
    5.0,
  );

  const stdDeleteCost = getPrice(
    "Standard Delete",
    process.env.MONITOR_FIRESTORE_STD_DELETE_COST,
    DEFAULT_COST_STANDARD_DELETE,
    0.01,
    5.0,
  );

  const readStdCostTotal = (stdReads / 1_000_000) * stdReadCost;
  const writeStdCostTotal = (stdWrites / 1_000_000) * stdWriteCost;
  const deleteStdCostTotal = (stdDeletes / 1_000_000) * stdDeleteCost;
  const readEntCostTotal = (entReadUnits / 1_000_000) * entReadUnitCost;
  const writeEntCostTotal = (entWriteUnits / 1_000_000) * entWriteUnitCost;

  const totalCost =
    readStdCostTotal +
    writeStdCostTotal +
    deleteStdCostTotal +
    readEntCostTotal +
    writeEntCostTotal;
  if (!isFinite(totalCost)) {
    throw new Error("Calculated Firestore cost is NaN/Infinite");
  }

  log(`Paid Firestore usage:`);
  log(
    `  Standard Reads: ${stdReads} @ $${stdReadCost}/million = $${readStdCostTotal.toFixed(2)}`,
  );
  log(
    `  Standard Writes: ${stdWrites} @ $${stdWriteCost}/million = $${writeStdCostTotal.toFixed(2)}`,
  );
  log(
    `  Standard Deletes: ${stdDeletes} @ $${stdDeleteCost}/million = $${deleteStdCostTotal.toFixed(2)}`,
  );
  log(
    `  Enterprise Read Units: ${entReadUnits} @ $${entReadUnitCost}/million = $${readEntCostTotal.toFixed(2)}`,
  );
  log(
    `  Enterprise Write Units: ${entWriteUnits} @ $${entWriteUnitCost}/million = $${writeEntCostTotal.toFixed(2)}`,
  );
  log(`  Total Firestore Cost: $${totalCost.toFixed(2)}`);

  return totalCost;
};
