import { createRequest, getMonitoringClient } from "./cloudMonitoring.js";
import { log, error } from "firebase-functions/logger";
import moment from "moment-timezone";

// NOTE: About Firestore Editions
// The pricing models are different for Standard edition
// and Enterprise edition. Enterprise pricing metrics are only
// available for the Enterprise edition databases, so we fetch
// those first - and take note of which database IDs are Enterprise.
// The standard edition metrics (like number of reads) are 
// available for both types, but we can simply skip any databases
// which we earlier identified as Enterprise.

const DEFAULT_COST_STANDARD_READ = 0.30; // USD per million reads
const DEFAULT_COST_STANDARD_WRITE = 0.90; // USD per million writes
const DEFAULT_COST_STANDARD_DELETE = 0.10; // USD per million deletes
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

    const enterpriseReadsRequest = createRequest(projectId, startOfMonthTs,
        'firestore.googleapis.com/api/billable_read_units',
    );

    // Enterprise uses write units for both writes and deletes
    const enterpriseWritesRequest = createRequest(projectId, startOfMonthTs,
        'firestore.googleapis.com/api/billable_write_units',
    );

    const [enterpriseReadsData, enterpriseWritesData] = await Promise.all([
        monitoringClient.listTimeSeries(enterpriseReadsRequest),
        monitoringClient.listTimeSeries(enterpriseWritesRequest),
    ]);

    // To avoid creating potentially hundreds of thousands of
    // moment objects we create one in the correct timezone, 
    // and just mutate it for each point. Slightly faster
    // and much less garbage collection. 
    const pointMoment = moment().millisecond(0).tz("America/Los_Angeles");
    const getDateByUnixTs = unixTs => {
        const diff = unixTs - pointMoment.unix();
        pointMoment.add(diff, 'seconds');
        return pointMoment.date().toString(); // 1-31
    }

    const enterpriseDatabaseIds = new Set();
    const calculatePaidOperations = (db, isEnterpriseRequest, freeQuota) => {
        let result = 0;
        const databaseId = db.resource.labels.database_id;

        if (isEnterpriseRequest) {
            // Enterprise request - mark this db as enterprise
            enterpriseDatabaseIds.add(databaseId);
        } else {
            // Standard request - skip enterprise dbs
            if (enterpriseDatabaseIds.has(databaseId)) return;
        }

        const isFreeTierDb = databaseId === freeTierDatabaseId;
        const perDay = isFreeTierDb ? {} : undefined;

        db.points.forEach(point => {
            if (point.value.int64Value !== "0") return;
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
            Object.values(perDay).forEach(dailyUsage => {
                result += Math.max(0, dailyUsage - freeQuota);
            });
        }

        const labelName = db.metric.labels.type || db.metric.labels.api_method || 'unknown';
        log(`  Firestore DB ${databaseId} Paid ${labelName}-operations: ${result}`);
        return result;
    };

    log('Firestore Enterprise Edition Usage:');

    let entReadUnits = 0;
    enterpriseReadsData[0].forEach(db => {
        entReadUnits += calculatePaidOperations(db, true, FREE_TIER_ENTERPRISE_DAILY_READ_UNITS);
    });

    let entWriteUnits = 0;
    enterpriseWritesData[0].forEach(db => {
        entWriteUnits += calculatePaidOperations(db, true, FREE_TIER_ENTERPRISE_DAILY_WRITE_UNITS);
    });

    // NOTE: There seems to be a bug in the monitoring API where the
    // supposed required /Database/ part of the metric type must be
    // omitted for the request to succeed. 
    // I submitted an issue on this: 
    // https://issuetracker.google.com/issues/449423585

    const standardReadsRequest = createRequest(projectId, startOfMonthTs,
        'firestore.googleapis.com/document/read_ops_count',
    );

    const standardWritesRequest = createRequest(projectId, startOfMonthTs,
        'firestore.googleapis.com/document/write_ops_count',
    );

    const standardDeletesRequest = createRequest(projectId, startOfMonthTs,
        'firestore.googleapis.com/document/delete_ops_count',
    );

    const [standardReadsData, standardWritesData, standardDeletesData] = await Promise.all([
        monitoringClient.listTimeSeries(standardReadsRequest),
        monitoringClient.listTimeSeries(standardWritesRequest),
        monitoringClient.listTimeSeries(standardDeletesRequest),
    ]);

    log('Firestore Standard Edition Usage:');

    let stdReads = 0;
    standardReadsData[0].forEach(db => {
        stdReads += calculatePaidOperations(db, false, FREE_TIER_STANDARD_DAILY_READS);
    });

    let stdWrites = 0;
    standardWritesData[0].forEach(db => {
        stdWrites += calculatePaidOperations(db, false, FREE_TIER_STANDARD_DAILY_WRITES);
    });

    let stdDeletes = 0;
    standardDeletesData[0].forEach(db => {
        stdDeletes += calculatePaidOperations(db, false, FREE_TIER_STANDARD_DAILY_DELETES);
    });

    const getPrice = (envVar, defaultValue, name) => {
        try {
            const customPrice = parseFloat(envVar);

            if (!isFinite(customPrice)) {
                throw new Error("NaN/Infinite");
            } else if (customPrice < 0) {
                throw new Error("Price must be greater than 0");
            } else if (customPrice < 0.01) {
                throw new Error("Price must be greater than 0.01 USD. Note that the price is per million operations.");
            } else if (customPrice > 1.00) {
                throw new Error("Above maximum allowed price of $1.00. Note that the price is per million operations.");
            }

            return customPrice;
        } catch (e) {
            error(`Error with ${name} cost configuration (${envVar}): ${e.message}. Using default of $${defaultValue} per million ${name}s.`);
            return defaultValue;
        }
    }

    const entReadUnitCost = getPrice(
        process.env.MONITOR_FIRESTORE_ENT_READ_UNIT_COST,
        DEFAULT_COST_ENTERPRISE_READ_UNIT,
        "Enterprise Read Unit"
    );

    const entWriteUnitCost = getPrice(
        process.env.MONITOR_FIRESTORE_ENT_WRITE_UNIT_COST,
        DEFAULT_COST_ENTERPRISE_WRITE_UNIT,
        "Enterprise Write Unit"
    );

    const stdReadCost = getPrice(
        process.env.MONITOR_FIRESTORE_STD_READ_COST,
        DEFAULT_COST_STANDARD_READ,
        "Standard Read"
    );

    const stdWriteCost = getPrice(
        process.env.MONITOR_FIRESTORE_STD_WRITE_COST,
        DEFAULT_COST_STANDARD_WRITE,
        "Standard Write"
    );

    const stdDeleteCost = getPrice(
        process.env.MONITOR_FIRESTORE_STD_DELETE_COST,
        DEFAULT_COST_STANDARD_DELETE,
        "Standard Delete"
    );

    const readStdCostTotal = (stdReads / 1_000_000) * stdReadCost;
    const writeStdCostTotal = (stdWrites / 1_000_000) * stdWriteCost;
    const deleteStdCostTotal = (stdDeletes / 1_000_000) * stdDeleteCost;
    const readEntCostTotal = (entReadUnits / 1_000_000) * entReadUnitCost;
    const writeEntCostTotal = (entWriteUnits / 1_000_000) * entWriteUnitCost;

    const totalCost = readStdCostTotal + writeStdCostTotal + deleteStdCostTotal + readEntCostTotal + writeEntCostTotal;

    log(`Firestore usage:`);
    log(`  Standard Reads: ${stdReads} @ $${stdReadCost}/million = $${readStdCostTotal.toFixed(2)}`);
    log(`  Standard Writes: ${stdWrites} @ $${stdWriteCost}/million = $${writeStdCostTotal.toFixed(2)}`);
    log(`  Standard Deletes: ${stdDeletes} @ $${stdDeleteCost}/million = $${deleteStdCostTotal.toFixed(2)}`);
    log(`  Enterprise Read Units: ${entReadUnits} @ $${entReadUnitCost}/million = $${readEntCostTotal.toFixed(2)}`);
    log(`  Enterprise Write Units: ${entWriteUnits} @ $${entWriteUnitCost}/million = $${writeEntCostTotal.toFixed(2)}`);
    log(`  Total Firestore Cost: $${totalCost.toFixed(2)}`);

    return totalCost;
};

