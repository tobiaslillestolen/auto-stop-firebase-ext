import { onRequest } from "firebase-functions/v2/https";
import { log, error } from "firebase-functions/logger";

import { CloudBillingClient } from "@google-cloud/billing";
import { BudgetServiceClient } from "@google-cloud/billing-budgets";
import { MetricServiceClient } from "@google-cloud/monitoring";

import moment from "moment-timezone";

const budgetClient = new BudgetServiceClient();
const billingClient = new CloudBillingClient();
const monitoringClient = new MetricServiceClient();

// TODO: Keep up to date with issue here: https://github.com/deep-rock-development/auto-stop-firebase-ext/issues/21
// we might want to publish this funcitonality as a firebase extension
// or an upgrade to the existing auto-stop-firebase-ext extension
// 1. support multiple databases [TESTED - WORKS]
// 2. support enterprise edition [Should work - test]
// 3. Add TTL deletion detection https://cloud.google.com/firestore/native/docs/understand-performance-monitoring#ttl_metrics [Should work - test]
// 4. Check if we can prevent triggering the function if monitoring is disabled
// 5. Support for hosting bandwidth [TESTED - WORKS]
// 6. Increase concurrency for requests DONE
//
// NOTE: As free tier is per day, and relatively low we just ignore it. Though it should
// be noted that the budget shouldn't be set to an extremely low value.

// Metrics for Firestore: https://cloud.google.com/monitoring/api/metrics_gcp_d_h#gcp-firestore


export const monitorUsage = async () => {
    if (process.env.MONITOR_FIRESTORE !== "true" && process.env.MONITOR_HOSTING !== "true") {
        log("Both Firestore and Hosting monitoring are disabled - exiting");
        return;
    }

    log("Checking for Firestore/Hosting overage at", new Date().toISOString());

    const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;

    // NOTE: Google uses Pacific Time to calculate the billing 
    // period for all customers, regardless of their time zone.
    // The time zone of the function can be set in extension.yaml

    const startOfMonthTs = moment()
        .tz("America/Los_Angeles")
        .startOf('month')
        .unix();

    const createRequest = metricType => ({
        name: monitoringClient.projectPath(projectId),
        filter: `metric.type="${metricType}"`,
        interval: {
            startTime: {
                seconds: startOfMonthTs,
            },
            endTime: {
                seconds: moment().unix(),
            },
        },
    });

    const prms = [];
    let totalCost = 0;
    let budgetAmount;

    const budgetPrm = fetchBudget(projectId).then(amount => {
        budgetAmount = amount;
    });
    prms.push(budgetPrm);

    if (process.env.MONITOR_FIRESTORE === "true") {
        // NOTE: There seems to be a bug in the monitoring API where the
        // supposed required /Database/ part of the metric type must be
        // omitted for the request to succeed. 
        // I submitted an issue on this: 
        // https://issuetracker.google.com/issues/449423585
        const readRequest = createRequest("firestore.googleapis.com/document/read_ops_count");
        const writeRequest = createRequest("firestore.googleapis.com/document/write_ops_count");
        const deleteRequest = createRequest("firestore.googleapis.com/document/delete_ops_count");
        const ttlDeleteRequest = createRequest("firestore.googleapis.com/document/ttl_deletion_count");

        const firestorePrm = fetchFirestoreSpend({
            readRequest,
            writeRequest,
            deleteRequest,
            ttlDeleteRequest,
        }).then(cost => {
            totalCost += cost;
        });

        prms.push(firestorePrm);
    }

    if (process.env.MONITOR_HOSTING === "true") {
        const hostingRequest = createRequest("firebasehosting.googleapis.com/network/sent_bytes_count");
        const hostingPrm = fetchHostingSpend({ hostingRequest }).then(cost => {
            totalCost += cost;
        });

        prms.push(hostingPrm);
    }

    await Promise.all(prms);

    if (totalCost > budgetAmount) {
        log(`🚨 Firestore cost has exceeded the budget of $${budgetAmount}. Executing disable strategy!`);
        // TODO: Trigger extension and disable services / remove billing account
        return { totalCost: totalCost.toFixed(2), budgetAmount: budgetAmount.toFixed(2) };
    }

    log(`✅ Firestore/Hosting cost of $${totalCost.toFixed(2)} is within the budget of $${budgetAmount.toFixed(2)}.`);
    return { totalCost: totalCost.toFixed(2), budgetAmount: budgetAmount.toFixed(2) };
};


const fetchHostingSpend = async ({ hostingRequest }) => {
    const [hostingResponse] = await monitoringClient.listTimeSeries(hostingRequest);

    let price;
    const defaultPrice = 0.15; // USD per GB
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
        price = defaultPrice;
    }

    let totalBytes = 0;

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
        log(`Total bytes for ${entryName}: ${entryBytes} bytes (${entryGb.toFixed(2)} GB)`);
        totalBytes += entryBytes;
    });

    const totalGB = totalBytes / (1024 * 1024 * 1024);
    const totalCost = totalGB * price;
    log(`Hosting Bandwidth usage:`);
    log(`  Total Bytes: ${totalBytes} bytes (${totalGB.toFixed(2)} GB) @ $${price}/GB = $${totalCost.toFixed(2)}`);
    return totalCost;
};

const fetchFirestoreSpend = async ({
    readRequest,
    writeRequest,
    deleteRequest,
    ttlDeleteRequest,
}) => {
    let readOps = 0;
    let writeOps = 0;
    let deleteOps = 0;
    let ttlDeleteOps = 0;

    const readPrm = monitoringClient.listTimeSeries(readRequest);
    const writePrm = monitoringClient.listTimeSeries(writeRequest);
    const deletePrm = monitoringClient.listTimeSeries(deleteRequest);
    const ttlDeletePrm = monitoringClient.listTimeSeries(ttlDeleteRequest);

    const responses = await Promise.all([readPrm, writePrm, deletePrm, ttlDeletePrm]);
    const readResponse = responses[0][0];
    const writeResponse = responses[1][0];
    const deleteResponse = responses[2][0];
    const ttlDeleteResponse = responses[3][0];

    // NOTE: This loops through all Firestore databases in the project so the
    // system supports multiple databases, both standard and enterprise

    readResponse.forEach(db => {
        db.points.forEach(point => {
            if (point.value.int64Value === "0") return;
            readOps += parseInt(point.value.int64Value, 10);
        });
    });

    writeResponse.forEach(db => {
        db.points.forEach(point => {
            if (point.value.int64Value === "0") return;
            writeOps += parseInt(point.value.int64Value, 10);
        });
    });

    deleteResponse.forEach(db => {
        db.points.forEach(point => {
            if (point.value.int64Value === "0") return;
            deleteOps += parseInt(point.value.int64Value, 10);
        });
    });

    ttlDeleteResponse.forEach(db => {
        db.points.forEach(point => {
            if (point.value.int64Value === "0") return;
            ttlDeleteOps += parseInt(point.value.int64Value, 10);
        });
    });

    // Default prices
    let readCost, writeCost, deleteCost;
    const defaultReadCost = 0.05; // USD per million reads
    const defaultWriteCost = 0.26; // USD per million writes
    const defaultDeleteCost = 0.26; // USD per million deletes

    const validatePrice = (field, price) => {
        if (!isFinite(price)) return "Invalid price - NaN/Infinite";
        if (price < 0) return "Invalid price - price must be greater than 0";
        if (price < 0.01) return `Invalid price for ${field} - below minimum allowed price of $0.01. Note that the price is per million operations.`;
        if (price > 1.00) return `Invalid price for ${field} - above maximum allowed price of $1.00. Note that the price is per million operations.`;
        return null;
    }

    try {
        const r = parseFloat(process.env.MONITOR_FIRESTORE_BUDGET_READ_COST);
        const readPriceError = validatePrice("reads", r);
        if (readPriceError) {
            throw new Error(readPriceError);
        }
        readCost = r;
    } catch (e) {
        error(`Error with read cost configuration (${process.env.MONITOR_FIRESTORE_BUDGET_READ_COST}): ${e.message}. Using default of $${defaultReadCost} per million reads.`);
        readCost = defaultReadCost;
    }

    try {
        const w = parseFloat(process.env.MONITOR_FIRESTORE_BUDGET_WRITE_COST);
        const writePriceError = validatePrice("writes", w);
        if (writePriceError) {
            throw new Error(writePriceError);
        }
        writeCost = w;
    } catch (e) {
        error(`Error with write cost configuration (${process.env.MONITOR_FIRESTORE_BUDGET_WRITE_COST}): ${e.message}. Using default of $${defaultWriteCost} per million writes.`);
        writeCost = defaultWriteCost;
    }

    try {
        const d = parseFloat(process.env.MONITOR_FIRESTORE_BUDGET_DELETE_COST);
        const deletePriceError = validatePrice("deletes", d);
        if (deletePriceError) {
            throw new Error(deletePriceError);
        }
        deleteCost = d;
    } catch (e) {
        error(`Error with delete cost configuration (${process.env.MONITOR_FIRESTORE_BUDGET_DELETE_COST}): ${e.message}. Using default of $${defaultDeleteCost} per million deletes.`);
        deleteCost = defaultDeleteCost;
    }

    const readCostTotal = (readOps / 1_000_000) * readCost;
    const writeCostTotal = (writeOps / 1_000_000) * writeCost;
    const deleteCostTotal = ((deleteOps + ttlDeleteOps) / 1_000_000) * deleteCost;
    const totalCost = readCostTotal + writeCostTotal + deleteCostTotal;

    log(`Firestore usage:`);
    log(`  Reads: ${readOps} @ $${readCost}/million = $${readCostTotal.toFixed(2)}`);
    log(`  Writes: ${writeOps} @ $${writeCost}/million = $${writeCostTotal.toFixed(2)}`);
    log(`  Deletes: ${deleteOps} + TTL Deletes: ${ttlDeleteOps} @ $${deleteCost}/million = $${deleteCostTotal.toFixed(2)}`);
    log(`  Total Firestore Cost: $${totalCost.toFixed(2)}`);

    return totalCost;
};


const fetchBudget = async (projectId) => {
    const [billingAccountInfo] = await billingClient.getProjectBillingInfo({ name: `projects/${projectId}` });
    const { billingAccountName } = billingAccountInfo;  // billingAccounts/000000-000000-000000
    const billingAccountId = billingAccountName.split("/")[1];

    const budgetId = process.env.MONITOR_BUDGET_ID;
    if (typeof budgetId !== "string" || budgetId.length === 0) {
        error("Budget ID is not set or invalid:", budgetId);
        throw new Error("The budget ID is not set or invalid. Please re-initialize the extension with a valid budget ID.");
    }

    const budgetPath = await budgetClient.budgetPath(billingAccountId, budgetId);
    const [budgetData] = await budgetClient.getBudget({
        name: budgetPath,
        budgetFilter: {
            projects: [`projects/${projectId}`]
        }
    });

    const currency = budgetData?.amount?.specifiedAmount?.currencyCode;
    if (currency !== "USD") {
        throw new Error(`Budget currency is not in USD - only budgets in USD are supported. Currency is set to: ${currency}`);
    }

    const primaryUnits = parseFloat(budgetData?.amount?.specifiedAmount?.units);
    const nanoUnits = parseFloat(budgetData?.amount?.specifiedAmount?.nanos);
    const budgetAmount = primaryUnits + (nanoUnits / 1_000_000_000);

    if (!isFinite(budgetAmount) || budgetAmount <= 0) {
        throw new Error(`Budget amount is not valid: ${budgetData?.amount?.specifiedAmount?.units}. Amount must be a positive finite number.`);
    }

    return budgetAmount;
};
