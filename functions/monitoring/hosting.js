import { createRequest, getMonitoringClient } from "./cloudMonitoring.js";
import { log, error } from "firebase-functions/logger";

const DEFAULT_HOSTING_BANDWIDTH_COST = 0.15; // USD per GB

export const getHostingCost = async (projectId, startOfMonthTs) => {
    const monitoringClient = getMonitoringClient();
    const hostingRequest = createRequest(projectId, startOfMonthTs,
        'firebasehosting.googleapis.com/network/sent_bytes_count'
    )

    const [hostingResponse] = await monitoringClient.listTimeSeries(hostingRequest);

    let price;
    try {
        const customPriceString = process.env.MONITOR_HOSTING_BANDWIDTH_COST;
        const customPrice = parseFloat(customPriceString);

        if (!isFinite(customPrice)) {
            throw new Error("Invalid price - NaN/Infinite");
        } else if (customPrice < 0) {
            throw new Error("Invalid price - price must be greater than 0");
        } else if (customPrice < 0.01) {
            throw new Error("Invalid price - below minimum allowed price of $0.01 per GB.");
        } else if (customPrice > 5.00) {
            throw new Error("Invalid price - above maximum allowed price of $5.00 per GB.");
        }

        price = customPrice;
    } catch (e) {
        error(`Error with hosting bandwidth cost configuration ("${process.env.MONITOR_HOSTING_BANDWIDTH_COST}"): ${e.message}. Using default of $${defaultPrice} per GB.`);
        price = DEFAULT_HOSTING_BANDWIDTH_COST;
    }

    let totalBytes = 0;

    log(`Hosting Bandwidth usage:`);
    hostingResponse.forEach(entry => {
        let entryBytes = 0;
        entry.points.forEach(point => {
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
        log(`  Total bytes for site ${entryName}: ${entryBytes} bytes (${entryGb.toFixed(2)} GB)`);
        totalBytes += entryBytes;
    });

    const totalGB = totalBytes / (1024 * 1024 * 1024);
    const totalCost = totalGB * price;
    log(`  Total Bytes: ${totalBytes} bytes (${totalGB.toFixed(2)} GB) @ $${price}/GB = $${totalCost.toFixed(2)}`);

    return totalCost;
};
