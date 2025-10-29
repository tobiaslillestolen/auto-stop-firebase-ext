import { log, error } from "firebase-functions/logger";
import { executeDisable } from "../service.js";
import { getFirestoreCost } from "./firestore.js";
import { getHostingCost } from "./hosting.js";
import { getStorageCost } from "./storage.js";
import { getCloudFunctionsCost } from "./cloudFunctions.js";

import moment from "moment-timezone";

import { CloudBillingClient } from "@google-cloud/billing";
import { BudgetServiceClient } from "@google-cloud/billing-budgets";

const budgetClient = new BudgetServiceClient();
const billingClient = new CloudBillingClient();

export const monitorUsage = async () => {
  const { MONITORING_ENABLED } = process.env;
  if (MONITORING_ENABLED !== "true" && MONITORING_ENABLED !== "test") {
    log(
      "Monitoring is disabled. You might want to reinstall the extension with the monitoring schedule set to NEVER to prevent unnecessary invocations of this function. This function will now exit without doing anything.",
    );
    return;
  }

  log(
    "Checking for Firestore/Hosting overage at",
    new Date().toISOString(),
    MONITORING_ENABLED === "test" ? "(TEST MODE - Logging only)" : "",
  );

  const projectId = JSON.parse(process.env.FIREBASE_CONFIG).projectId;

  // NOTE: Google uses Pacific Time to calculate the billing
  // period for all customers, regardless of their time zone.
  // The time zone of the function can be set in extension.yaml

  const startOfMonthTs = moment()
    .tz("America/Los_Angeles")
    .startOf("month")
    .unix();

  const [budgetAmount, firestoreCost, hostingCost, storageCost, cloudRunCost] =
    await Promise.all([
      fetchBudget(projectId),
      getFirestoreCost(projectId, startOfMonthTs),
      getHostingCost(projectId, startOfMonthTs),
      getStorageCost(projectId, startOfMonthTs),
      getCloudFunctionsCost(projectId, startOfMonthTs),
    ]);

  const totalCost = firestoreCost + hostingCost + storageCost + cloudRunCost;

  if (totalCost <= budgetAmount) {
    log(
      `✅ Monitored usage $${totalCost.toFixed(2)} is within the budget of $${budgetAmount.toFixed(2)}.`,
    );
    return;
  }

  log(
    `🚨 Firestore cost of $${totalCost.toFixed(2)} has exceeded the budget of $${budgetAmount.toFixed(2)}.`,
  );

  if (MONITORING_ENABLED === "test") {
    log(
      "⚠️ Monitoring is in test mode - disable strategy will not be executed.",
    );
  } else {
    await executeDisable();
    log("✅ Disable strategy executed.");
  }
};

const fetchBudget = async (projectId) => {
  const [billingAccountInfo] = await billingClient.getProjectBillingInfo({
    name: `projects/${projectId}`,
  });
  const { billingAccountName } = billingAccountInfo; // billingAccounts/000000-000000-000000
  const billingAccountId = billingAccountName.split("/")[1];

  const budgetId = process.env.MONITOR_BUDGET_ID;
  if (typeof budgetId !== "string" || budgetId.length === 0) {
    error("Budget ID is not set or invalid:", budgetId);
    throw new Error(
      "The budget ID is not set or invalid. Please re-initialize the extension with a valid budget ID.",
    );
  }

  const budgetPath = await budgetClient.budgetPath(billingAccountId, budgetId);
  const [budgetData] = await budgetClient.getBudget({
    name: budgetPath,
    budgetFilter: {
      projects: [`projects/${projectId}`],
    },
  });

  const currency = budgetData?.amount?.specifiedAmount?.currencyCode;
  if (currency !== "USD") {
    throw new Error(
      `Budget currency is not in USD - only budgets in USD are supported. Currency is set to: ${currency}`,
    );
  }

  const primaryUnits = parseFloat(budgetData?.amount?.specifiedAmount?.units);
  const nanoUnits = parseFloat(budgetData?.amount?.specifiedAmount?.nanos);
  const budgetAmount = primaryUnits + nanoUnits / 1_000_000_000;

  if (!isFinite(budgetAmount) || budgetAmount <= 0) {
    throw new Error(
      `Budget amount is not valid: ${budgetData?.amount?.specifiedAmount?.units}. Amount must be a positive finite number.`,
    );
  }

  return budgetAmount;
};
