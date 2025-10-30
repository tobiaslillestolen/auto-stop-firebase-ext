import { createRequest, getMonitoringClient } from "./cloudMonitoring.js";
import { log } from "firebase-functions/logger";
import getPrice from "./getPrice.js";

const DEFAULT_HOSTING_BANDWIDTH_COST = 0.15; // USD per GB

export const getHostingCost = async (projectId, startOfMonthTs) => {
  const monitoringClient = getMonitoringClient();
  const hostingRequest = createRequest(
    projectId,
    startOfMonthTs,
    "firebasehosting.googleapis.com/network/sent_bytes_count",
  );

  const [hostingResponse] =
    await monitoringClient.listTimeSeries(hostingRequest);

  const price = getPrice(
    "Hosting Bandwidth",
    process.env.MONITOR_HOSTING_BANDWIDTH_COST,
    DEFAULT_HOSTING_BANDWIDTH_COST,
    0.01,
    5.0,
  );

  let totalBytes = 0;

  log(`Hosting Bandwidth usage:`);
  hostingResponse.forEach((entry) => {
    let entryBytes = 0;
    entry.points.forEach((point) => {
      if (point.value.int64Value === "0") return;
      const parsedBytes = parseInt(point.value.int64Value, 10);

      if (!isFinite(parsedBytes)) {
        throw new Error("Invalid byte count - NaN/Infinite");
      } else if (parsedBytes < 0) {
        throw new Error("Invalid byte count - must be greater than 0");
      }

      entryBytes += parsedBytes;
    });

    const entryGb = entryBytes / (1024 * 1024 * 1024);
    const entryName = entry?.resource?.labels?.site_name ?? "unknown_site";
    log(
      `  Total bytes for site ${entryName}: ${entryBytes} bytes (${entryGb.toFixed(2)} GB)`,
    );
    totalBytes += entryBytes;
  });

  const totalGB = totalBytes / (1024 * 1024 * 1024);
  const totalCost = totalGB * price;
  log(
    `  Total Bytes: ${totalBytes} bytes (${totalGB.toFixed(2)} GB) @ $${price}/GB = $${totalCost.toFixed(2)}`,
  );

  return totalCost;
};
