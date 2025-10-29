import { log, error } from "firebase-functions/logger";
import { executeDisable } from "../service.js";
import { getFirestoreCost } from "./firestore.js";
import { getHostingCost } from "./hosting.js";

import moment from "moment-timezone";

import { CloudBillingClient } from "@google-cloud/billing";
import { BudgetServiceClient } from "@google-cloud/billing-budgets";

const budgetClient = new BudgetServiceClient();
const billingClient = new CloudBillingClient();

// Metrics for Firestore: https://cloud.google.com/monitoring/api/metrics_gcp_d_h#gcp-firestore

export const monitorUsage = async () => {
    if (process.env.MONITORING_ENABLED !== "true") {
        log("Monitoring is disabled. You might want to reinstall the extension with the monitoring schedule set to NEVER to prevent unnecessary invocations of this function. This function will now exit without doing anything.");
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


    const prms = [];
    let totalCost = 0;
    let budgetAmount;

    const budgetPrm = fetchBudget(projectId).then(amount => {
        budgetAmount = amount;
    });
    prms.push(budgetPrm);

    const firestorePrm = getFirestoreCost(projectId, startOfMonthTs).then(cost => {
        totalCost += cost;
    });
    prms.push(firestorePrm);

    const hostingPrm = getHostingCost(projectId, startOfMonthTs).then(cost => {
        totalCost += cost;
    });
    prms.push(hostingPrm);

    await Promise.all(prms);

    if (totalCost > budgetAmount) {
        log(`🚨 Firestore cost of $${totalCost.toFixed(2)} has exceeded the budget of $${budgetAmount.toFixed(2)}. Executing disable strategy!`);
        await executeDisable();
        log("✅ Disable strategy executed.");
    } else {
        log(`✅ Firestore/Hosting cost of $${totalCost.toFixed(2)} is within the budget of $${budgetAmount.toFixed(2)}.`);
    }
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
