import { createRequest, getMonitoringClient } from "./cloudMonitoring.js";
import { log, error } from "firebase-functions/logger";
import getPrice from "./getPrice.js";

const DEFAULT_STORAGE_BANDWIDTH_COST = 0.12; // USD per GB
const FREE_BANDWIDTH_QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB free quota

export const getStorageCost = async (projectId, startOfMonthTs) => {
  const monitoringClient = getMonitoringClient();

  const egressRequest = createRequest(
    projectId,
    startOfMonthTs,
    "storage.googleapis.com/network/sent_bytes_count",
  );

  const [egressResponse] = await monitoringClient.listTimeSeries(egressRequest);

  // Can be used to monitor total API requests if needed
  // const apiRequest = createRequest(projectId, startOfMonthTs,
  //     'storage.googleapis.com/api/request_count'
  // );

  // const [apiResponse] = await monitoringClient.listTimeSeries(apiRequest);
  // const test = [];
  // apiResponse.forEach(bucket => {
  //     let entryBytes = 0;
  //     bucket.points.forEach(point => {
  //         if (point.value.int64Value === "0") return;
  //         const parsedBytes = parseInt(point.value.int64Value, 10);
  //         entryBytes += parsedBytes;
  //     });
  //     delete bucket.points;
  //     test.push({ ...bucket, totalBytes: entryBytes });
  // });
  // return test;

  // NOTE: The free quota only applies to
  // certain regions. See:
  // https://cloud.google.com/storage/pricing#cloud-storage-always-free
  let egressBytesQuotaRegions = 0; // Egress bytes eligible for free quota
  let egressBytesOtherRegions = 0; // Egress bytes NOT eligible for free quota

  log(`GCS Storage Bandwidth usage:`);
  if (egressResponse.length >= 100) {
    log(`  More than 100 buckets. Detailed per-bucket logging skipped.`);
  }

  egressResponse.forEach((bucket) => {
    let entryBytes = 0;
    bucket.points.forEach((point) => {
      if (point.value.int64Value === "0") return;
      const parsedBytes = parseInt(point.value.int64Value, 10);

      if (!isFinite(parsedBytes)) {
        throw new Error("Invalid byte count - NaN/Infinite");
      } else if (parsedBytes < 0) {
        throw new Error("Invalid byte count - must be greater than 0");
      }

      entryBytes += parsedBytes;
    });

    const name = bucket?.resource?.labels?.bucket_name ?? "unknown";
    const gb = entryBytes / (1024 * 1024 * 1024);
    if (egressResponse.length < 100) {
      log(
        `  Total network egress for bucket ${name}: ${entryBytes} bytes. (${gb.toFixed(2)} GB)`,
      );
    }

    const location = bucket?.resource?.labels?.location;
    const quotaRegion =
      location === "us-central1" ||
      location === "us-west1" ||
      location === "us-east1";

    if (quotaRegion) {
      egressBytesQuotaRegions += entryBytes;
    } else {
      egressBytesOtherRegions += entryBytes;
    }
  });

  const price = getPrice(
    "Storage Network Egress Bandwidth",
    process.env.MONITOR_STORAGE_BANDWIDTH_COST,
    DEFAULT_STORAGE_BANDWIDTH_COST,
    0.01,
    5.0,
  );

  const quotaOvershootBytes = Math.max(
    0,
    egressBytesQuotaRegions - FREE_BANDWIDTH_QUOTA_BYTES,
  );
  const quotaOvershootGB = quotaOvershootBytes / (1024 * 1024 * 1024);
  log(
    `  Egress bytes in free quota-eligible regions: ${egressBytesQuotaRegions} bytes. ${(Math.min(egressBytesQuotaRegions, FREE_BANDWIDTH_QUOTA_BYTES) / FREE_BANDWIDTH_QUOTA_BYTES).toFixed(2)}% of free quota used. Quota overshoot: ${quotaOvershootBytes} bytes (${quotaOvershootGB.toFixed(2)} GB).`,
  );

  const egressBytesOtherRegionsGB =
    egressBytesOtherRegions / (1024 * 1024 * 1024);
  log(
    `  Egress bytes in non-quota regions: ${egressBytesOtherRegions} bytes. (${egressBytesOtherRegionsGB.toFixed(2)} GB).`,
  );

  const billableEgressBytes = quotaOvershootBytes + egressBytesOtherRegions;
  const totalGB = billableEgressBytes / (1024 * 1024 * 1024);
  const totalCost = totalGB * price;
  log(
    `  Total billable egress: ${billableEgressBytes} bytes (${totalGB.toFixed(2)} GB) @ $${price}/GB = $${totalCost.toFixed(2)}`,
  );

  return totalCost;
};
