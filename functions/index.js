// Import the firebase-functions package using ES module syntax
import * as functions from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { stopServices, installExtension } from "./service.js";
import { monitorUsage } from "./monitoring/monitoring.js";

// Initialize the Firebase Admin SDK
initializeApp();

/**
 * Extension Lifecycle: onInstall
 */
export const onInstallExtension = functions.tasks
    .taskQueue()
    .onDispatch(async () => {
        await installExtension();
    });

/**
 * Triggered when a budget message is published to the topic.
 */
export const stopTriggered = functions.pubsub
    .topic(process.env.TOPIC_NAME)
    .onPublish(async (message) => {
        console.log("ℹ️ Received budget alert message...");
        await stopServices(message);
    });

/**
 * Triggered every 4 minutes to monitor Firestore usage. For
 * fast response times.
 */
export const monitoring = functions.pubsub
    .schedule(process.env.MONITORING_SCHEDULE).onRun(async () => {
        console.log("ℹ️ Usage monitor triggered...");
        await monitorUsage();
    });
