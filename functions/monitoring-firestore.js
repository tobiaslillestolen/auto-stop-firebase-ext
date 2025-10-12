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
//
// NOTE: As free tier is per day, and relatively low we just ignore it. Though it should
// be noted that the budget shouldn't be set to an extremely low value.

// Metrics for Firestore: https://cloud.google.com/monitoring/api/metrics_gcp_d_h#gcp-firestore


export const monitorFirestoreUsage = async () => {
    // TODO: Is there a way to not deploy the function if we don't want it?
    if (process.env.MONITOR_FIRESTORE !== "true") {
        log("Firestore monitoring is disabled - exiting");
        return;
    }

    log("Checking for Firestore overage at", new Date().toISOString(), "Function v 1.1.1");

    const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;

    // NOTE: Google uses Pacific Time to calculate the billing 
    // period for all customers, regardless of their time zone.
    // The time zone of the function can be set in extension.yaml

    // TODO: Remove moment-timezone dependency? We could perhaps
    // rely on setting the tz and using native Date functions?
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

    // NOTE: There seems to be a bug in the monitoring API where the
    // supposed required /Database/ part of the metric type must be
    // omitted for the request to succeed. 
    // I submitted an issue on this: 
    // https://issuetracker.google.com/issues/449423585
    const readRequest = createRequest("firestore.googleapis.com/document/read_ops_count");
    const writeRequest = createRequest("firestore.googleapis.com/document/write_ops_count");
    const deleteRequest = createRequest("firestore.googleapis.com/document/delete_ops_count");
    const ttlDeleteRequest = createRequest("firestore.googleapis.com/document/ttl_deletion_count");

    // NOTE: This works if we want to monitor hosting bandwidth
    // const hostingRequest = createRequest("firebasehosting.googleapis.com/network/sent_bytes_count");

    let readOps = 0;
    let writeOps = 0;
    let deleteOps = 0;
    let ttlDeleteOps = 0;
    let readResponse, writeResponse, deleteResponse, ttlDeleteResponse; // hostingResponse;

    [readResponse] = await monitoringClient.listTimeSeries(readRequest);
    [writeResponse] = await monitoringClient.listTimeSeries(writeRequest);
    [deleteResponse] = await monitoringClient.listTimeSeries(deleteRequest);
    [ttlDeleteResponse] = await monitoringClient.listTimeSeries(ttlDeleteRequest);
    // [hostingResponse] = await monitoringClient.listTimeSeries(hostingRequest);

    // NOTE: Loop through all Firestore databases in the project

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

    const [billingAccountInfo] = await billingClient.getProjectBillingInfo({ name: `projects/${projectId}` });
    const { billingAccountName } = billingAccountInfo;  // billingAccounts/000000-000000-000000
    const billingAccountId = billingAccountName.split("/")[1];

    const budgetId = process.env.MONITOR_FIRESTORE_BUDGET_ID;
    const budgetPath = await budgetClient.budgetPath(billingAccountId, budgetId);
    const [budgetData] = await budgetClient.getBudget({
        name: budgetPath,
        budgetFilter: {
            projects: [`projects/${projectId}`]
        }
    });

    const currency = budgetData?.amount?.specifiedAmount?.currencyCode;
    if (currency !== "USD") {
        throw new Error(`Budget currency is not in USD - only budgets in USD are supported. Currency is set to ${currency ?? "undefined"}`);
    }

    const primaryUnits = parseFloat(budgetData?.amount?.specifiedAmount?.units);
    const nanoUnits = parseFloat(budgetData?.amount?.specifiedAmount?.nanos);
    const budgetAmount = primaryUnits + (nanoUnits / 1_000_000_000);

    if (!isFinite(budgetAmount) || budgetAmount <= 0) {
        throw new Error(`Budget amount is not valid: ${budgetData?.amount?.specifiedAmount?.units}. Amount must be a positive finite number.`);
    }

    const readCostTotal = (readOps / 1_000_000) * readCost;
    const writeCostTotal = (writeOps / 1_000_000) * writeCost;
    const deleteCostTotal = ((deleteOps + ttlDeleteOps) / 1_000_000) * deleteCost;
    const totalCost = readCostTotal + writeCostTotal + deleteCostTotal;

    log(`Firestore usage for project ${projectId} since ${moment.unix(startOfMonthTs).format("YYYY-MM-DD HH:mm:ss")} (PST):`);
    log(`  Reads: ${readOps} @ $${readCost}/million = $${readCostTotal.toFixed(2)}`);
    log(`  Writes: ${writeOps} @ $${writeCost}/million = $${writeCostTotal.toFixed(2)}`);
    log(`  Deletes: ${deleteOps} + TTL Deletes: ${ttlDeleteOps} @ $${deleteCost}/million = $${deleteCostTotal.toFixed(2)}`);
    log(`  Total Firestore Cost: $${totalCost.toFixed(2)} of $${budgetAmount.toFixed(2)} budget`);

    if (totalCost > budgetAmount) {
        log(`🚨 Firestore cost has exceeded the budget of $${budgetAmount}. Executing disable strategy!`);
        // TODO: Trigger extension and disable services / remove billing account
    }

    // TODO: Remove this - temporary for testing while function is HTTPS
    log(JSON.stringify({ readOps, writeOps, deleteOps, ttlDeleteOps, budgetData, readCost, writeCost, deleteCost, totalCost, budgetAmount }, null, 2));
    return { readOps, writeOps, deleteOps, ttlDeleteOps, budgetData, billingAccountName, readCost, writeCost, deleteCost, totalCost, budgetAmount };
};
