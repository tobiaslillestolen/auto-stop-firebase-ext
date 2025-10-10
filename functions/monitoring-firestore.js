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
// 1. Create test suite / control panel
// 2. support multiple databases [TESTED - WORKS]
// 3. support enterprise edidtion [Should work - test]
// 4. Add TTL deletion detection https://cloud.google.com/firestore/native/docs/understand-performance-monitoring#ttl_metrics [Should work - test]
//
// NOTE: As free tier is per day, and relatively low we just ignore it. Though it should
// be noted that the budget shouldn't be set to an extremely low value.
//
// Metrics for Firestore: https://cloud.google.com/monitoring/api/metrics_gcp_d_h#gcp-firestore
// Tests should confirm that the following cases are included in
// the monitoring:
// - Security rule reads
// - NOOPS (queries that return no results, failed writes etc)


export const monitorFirestoreUsage = async () => {
    log("Checking for Firestore overage at", new Date().toISOString(), "Function v 1.1.1");

    const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;

    // NOTE: Google uses Pacific Time to calculate the billing 
    // period for all customers, regardless of their time zone.
    // The time zone is set in extension.yaml
    //
    // TODO: Remove moment-timezone dependency? We could perhaps
    // rely on setting the tz and using native Date functions?
    const startOfMonthTs = moment()
        .tz("America/Los_Angeles")
        .startOf('month')
        .unix();

    // TODO: Change this to startOfMonthTs, currently set to 10 min
    const createRequest = metricType => ({
        name: monitoringClient.projectPath(projectId),
        filter: `metric.type="${metricType}"`,
        interval: {
            startTime: {
                seconds: moment().subtract(600, 'seconds').unix(), // startOfMonthTs,
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
    // const hostingRequest = createRequest("firebasehosting.googleapis.com/network/sent_bytes_count");

    let readOps = 0;
    let writeOps = 0;
    let deleteOps = 0;
    let ttlDeleteOps = 0;
    let readResponse, writeResponse, deleteResponse, ttlDeleteResponse, hostingResponse;

    [readResponse] = await monitoringClient.listTimeSeries(readRequest);
    [writeResponse] = await monitoringClient.listTimeSeries(writeRequest);
    [deleteResponse] = await monitoringClient.listTimeSeries(deleteRequest);
    [ttlDeleteResponse] = await monitoringClient.listTimeSeries(ttlDeleteRequest);
    // [hostingResponse] = await monitoringClient.listTimeSeries(hostingRequest);

    // NOTE: There could be multiple databases - we loop through all of them

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

    log(JSON.stringify({ readOps, writeOps, deleteOps, ttlDeleteOps, budgetData, billingAccountName }));
    return { readOps, writeOps, deleteOps, ttlDeleteOps, budgetData, billingAccountName };
};
