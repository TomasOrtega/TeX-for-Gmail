"use strict";

class Communicator {
  static MAX_PENDING_REQUESTS = 16;
  static MAX_REQUEST_ID = 0x7fffffff;

  constructor(port) {
    if (!port?.onMessage?.addListener ||
        !port?.onDisconnect?.addListener ||
        typeof port.postMessage !== "function")
      throw new TypeError("Expected an extension runtime Port.");

    this.port = port;
    this.messageHandler = Object.create(null);
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    port.onMessage.addListener(message => this.handleMessage(message));
    port.onDisconnect.addListener(() => {
      const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
      this.rejectPending(
        port.error || runtime?.lastError ||
        "Communication target disconnected."
      );
    });
  }

  static get FAILURE() {
    return "0";
  }

  static get SUCCESS() {
    return "1";
  }

  static get REQUEST() {
    return "2";
  }

  validateCommand(cmd) {
    if (typeof cmd !== "string" ||
        !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(cmd))
      throw new Error("Invalid command name.");
  }

  allocateRequestId() {
    let id = this.nextRequestId;
    while (this.pendingRequests.has(id))
      id = id === Communicator.MAX_REQUEST_ID ? 1 : id + 1;
    this.nextRequestId = id === Communicator.MAX_REQUEST_ID ? 1 : id + 1;
    return id;
  }

  request(cmd, params) {
    return new Promise((resolve, reject) => {
      if (this.pendingRequests.size >= Communicator.MAX_PENDING_REQUESTS) {
        reject(this.errorPayload(
          "Too many pending requests.",
          "communicator.js, request"
        ));
        return;
      }

      let id;
      try {
        this.validateCommand(cmd);
        id = this.allocateRequestId();
      } catch (error) {
        reject(this.errorPayload(error, "communicator.js, request"));
        return;
      }

      const message = {
        code: Communicator.REQUEST,
        id,
        payload: { cmd, params }
      };
      this.pendingRequests.set(id, { reject, resolve });
      try {
        this.port.postMessage(message);
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(this.errorPayload(error, "communicator.js, request"));
      }
    });
  }

  reply(id, code, payload) {
    this.port.postMessage({ code, id, payload });
  }

  errorPayload(error, location) {
    const message = error?.message || String(error);
    return { err: message, location };
  }

  rejectPending(error) {
    const payload = this.errorPayload(error, "communicator.js, connection");
    for (const pending of this.pendingRequests.values())
      pending.reject(payload);
    this.pendingRequests.clear();
  }

  handleMessage(data) {
    if (!data || typeof data !== "object")
      return;

    const pending = this.pendingRequests.get(data.id);
    if (pending && (data.code === Communicator.SUCCESS ||
                    data.code === Communicator.FAILURE)) {
      this.pendingRequests.delete(data.id);
      if (data.code === Communicator.SUCCESS)
        pending.resolve(data.payload);
      else
        pending.reject(data.payload);
      return;
    }

    if (data.code !== Communicator.REQUEST ||
        !Number.isSafeInteger(data.id) ||
        data.id < 1 || data.id > Communicator.MAX_REQUEST_ID)
      return;

    const validPayload = data.payload &&
      typeof data.payload === "object" &&
      typeof data.payload.cmd === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(data.payload.cmd) &&
      (data.payload.params === undefined ||
       (data.payload.params !== null &&
        typeof data.payload.params === "object"));
    if (!validPayload) {
      this.reply(
        data.id,
        Communicator.FAILURE,
        this.errorPayload("Malformed request.", "communicator.js, handleMessage")
      );
      return;
    }

    const handler = this.messageHandler[data.payload.cmd];
    if (typeof handler !== "function") {
      this.reply(
        data.id,
        Communicator.FAILURE,
        this.errorPayload(
          `Unknown command: ${data.payload.cmd}`,
          "communicator.js, handleMessage"
        )
      );
      return;
    }

    try {
      Promise.resolve(handler(data.payload.params))
        .then(response => {
          if (!response ||
              (response.code !== Communicator.SUCCESS &&
               response.code !== Communicator.FAILURE))
            throw new Error("Message handler returned an invalid response.");
          this.reply(data.id, response.code, response.payload);
        })
        .catch(error => this.replyFailure(data.id, error));
    } catch (error) {
      this.replyFailure(data.id, error);
    }
  }

  replyFailure(id, error) {
    try {
      this.reply(
        id,
        Communicator.FAILURE,
        this.errorPayload(error, "communicator.js, handleMessage")
      );
    } catch (replyError) {
      console.error(replyError);
    }
  }
}
