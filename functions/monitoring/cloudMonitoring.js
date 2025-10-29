import { MetricServiceClient } from "@google-cloud/monitoring";

import moment from "moment-timezone";

/**
 * Creates a request object for fetching time series data
 * from Google Cloud Monitoring API. See available metric types
 * here:
 * https://cloud.google.com/monitoring/api/metrics_gcp_d_h#gcp-firestore
 *
 * @param {string} projectId - The GCP project ID.
 * @param {number} startOfMonthTs - The start of the month timestamp in seconds.
 * @param {string} metricType - The metric type to query.
 * @returns {object} The request object for the Monitoring API.
 */
export const createRequest = (projectId, startOfMonthTs, metricType) => ({
    name: getMonitoringClient().projectPath(projectId),
    filter: `metric.type="${metricType}"`,
    interval: {
        startTime: {
            seconds: startOfMonthTs,
        },
        endTime: {
            seconds: moment().unix(),
        },
    },
    // Reduce amount of data for processing (less work on our side)
    aggregation: {
        alignmentPeriod: {
            // 1 hour is the largest value which still avoids
            // errors due to DST changes (23/25 hours)
            seconds: 3600,
        },
        perSeriesAligner: "ALIGN_SUM",
    },
});

let monitoringClient;

/**
 * @returns {MetricServiceClient} The MetricServiceClient instance.
 */
export const getMonitoringClient = () => {
    if (!monitoringClient) {
        monitoringClient = new MetricServiceClient();
    }
    return monitoringClient;
};
