const config = require("./config");
const logger = require("./logger");

class TelecrmClient {
  constructor() {
    this.baseUrl = config.baseUrl;
    this.enterpriseId = config.enterpriseId;
    this.token = config.syncToken;
    this.lastRequestTime = 0;
    this.minRequestInterval = 250; // ms spacing to respect rate limits
  }

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise((res) => setTimeout(res, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  async _request(endpoint, options = {}, retries = 3) {
    if (!this.token || !this.enterpriseId) {
      throw new Error("TeleCRM credentials missing in configuration");
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    let attempt = 0;
    while (attempt <= retries) {
      await this._throttle();
      try {
        const response = await fetch(url, {
          ...options,
          headers,
        });

        // Handle 429 Too Many Requests
        if (response.status === 429) {
          attempt++;
          const retryAfterHeader = response.headers.get("retry-after");
          const waitTime = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : Math.pow(2, attempt) * 1000;
          logger.warn(`Rate limit 429 hit on ${endpoint}. Waiting ${waitTime}ms before retry ${attempt}/${retries}...`);
          if (attempt > retries) {
            throw new Error(`HTTP 429 Rate limit exceeded after ${retries} retries`);
          }
          await new Promise((res) => setTimeout(res, waitTime));
          continue;
        }

        // Handle 5xx server errors
        if (response.status >= 500) {
          attempt++;
          const waitTime = Math.pow(2, attempt) * 1000;
          logger.warn(`Server error ${response.status} on ${endpoint}. Waiting ${waitTime}ms before retry ${attempt}/${retries}...`);
          if (attempt > retries) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status} on ${endpoint}: ${errorText}`);
          }
          await new Promise((res) => setTimeout(res, waitTime));
          continue;
        }

        const data = await response.json().catch(() => null);

        if (!response.ok) {
          const errMsg = data?.message || data?.error || (data ? JSON.stringify(data) : response.statusText);
          throw new Error(`API Error [${response.status}] ${endpoint}: ${errMsg}`);
        }

        return data;
      } catch (err) {
        if (attempt >= retries || err.message.startsWith("API Error [4")) {
          // Do not retry 4xx errors other than 429
          throw err;
        }
        attempt++;
        const waitTime = Math.pow(2, attempt) * 1000;
        logger.warn(`Network/Request error on ${endpoint}: ${err.message}. Retrying (${attempt}/${retries}) in ${waitTime}ms...`);
        await new Promise((res) => setTimeout(res, waitTime));
      }
    }
  }

  /**
   * Search leads by filter fields (e.g. phone variants or empty for all)
   * Official endpoint: POST /enterprise/{enterpriseId}/lead/search?skip={skip}&limit={limit}
   */
  async searchLeads(filter = {}, skip = 0, limit = 100) {
    const endpoint = `/enterprise/${this.enterpriseId}/lead/search?skip=${skip}&limit=${limit}`;
    const body = JSON.stringify(filter);
    const res = await this._request(endpoint, {
      method: "POST",
      body,
    });
    // Response is typically { status: "success", data: [ ...leads ] } or array
    if (res && Array.isArray(res.data)) {
      return res.data;
    }
    if (Array.isArray(res)) {
      return res;
    }
    return [];
  }

  /**
   * Get complete lead details including actions
   * Official endpoint: GET /enterprise/{enterpriseId}/lead/{leadId}?includeActions=true&limit=100
   */
  async getLead(leadId, includeActions = true) {
    const endpoint = `/enterprise/${this.enterpriseId}/lead/${leadId}?includeActions=${includeActions}&limit=100`;
    const res = await this._request(endpoint, {
      method: "GET",
    });
    return res?.data || res;
  }

  /**
   * Update lead fields
   * Official endpoint: POST /enterprise/{enterpriseId}/lead/{leadId}
   * Body: { "fields": { ... } }
   */
  async updateLead(leadId, fields = {}) {
    const endpoint = `/enterprise/${this.enterpriseId}/lead/${leadId}`;
    const body = JSON.stringify({ fields });
    const res = await this._request(endpoint, {
      method: "POST",
      body,
    });
    return res?.data || res;
  }

  /**
   * Add an action / note to a lead
   * Official endpoint: POST /enterprise/{enterpriseId}/lead/{leadId}/action
   * Body: { "action": { "type": "SYSTEM_NOTE", "text": "...", "created_on": Date.now() } }
   */
  async createAction(leadId, actionData = {}) {
    const endpoint = `/enterprise/${this.enterpriseId}/lead/${leadId}/action`;
    const body = JSON.stringify({
      action: {
        type: actionData.type || "SYSTEM_NOTE",
        text: actionData.text || "",
        created_on: actionData.created_on || Date.now(),
        ...actionData,
      },
    });
    const res = await this._request(endpoint, {
      method: "POST",
      body,
    });
    return res?.data || res;
  }
}

module.exports = new TelecrmClient();
