"use strict";

/* A request event looks like this. `data` is the part we put into postMessage.
event = {
  ...
  data: {
    id: command id, used to reply
    code: FAILURE, SUCCESS, REQUEST, OR POST   // These are used to determine the type of message
    payload: {
      cmd: name of command
      params: the parameters needed
    }
  }
}
*/

/* A reply event looks like this. `data` is the part we put into postMessage.
event = {
  ...
  data: {
    id: command id,
    code: FAILURE, SUCCESS, REQUEST, OR POST
    payload: {
      ...
    }
  }
}
*/
class Communicator {
  static MAX_PENDING_REQUESTS = 16;

  target; // where the messages come in/out
  messageHandler;
  pendingRequests;

  constructor(target) {
    this.target = target;
    this.messageHandler = Object.create(null);
    this.pendingRequests = new Map();
    this.target.addEventListener(
      "message",
      event => this.handleMessage(event),
      false
    );
    this.target.addEventListener(
      "disconnect",
      () => this.rejectPending("Communication target disconnected."),
      false
    );
    this.target.addEventListener(
      "error",
      event => this.rejectPending(
        event && (event.error || event.message) || "Communication target failed."
      ),
      false
    );
  }

  static get FAILURE() {
    return '0';
  }

  static get SUCCESS() {
    return '1';
  }

  static get REQUEST() {
    return '2';
  }

  static get POST() {
    return '3';
  }

  makeData(cmd, code, params) {
    if (typeof cmd !== "string" ||
        !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(cmd))
      throw new Error("Invalid command name.");
    return {
      id: Math.round(Math.random() * Math.pow(2, 64)),
      code: code,
      payload: {
        cmd: cmd,
        params: params
      }
    };
  }

  post(cmd, params, transferList) {
    let data = this.makeData(cmd, Communicator.POST, params);
    this.target.postMessage(data, transferList);
  }

  request(cmd, params, transferList) {
    return new Promise((resolve, reject) => {
      if (this.pendingRequests.size >= Communicator.MAX_PENDING_REQUESTS) {
        reject(this.errorPayload(
          "Too many pending requests.",
          `communicator.js, request`
        ));
        return;
      }

      let data;
      try {
        data = this.makeData(cmd, Communicator.REQUEST, params);
      } catch (ex) {
        reject(this.errorPayload(ex, `communicator.js, request`));
        return;
      }
      this.pendingRequests.set(data.id, { resolve: resolve, reject: reject });
      try {
        this.target.postMessage(data, transferList);
      } catch (ex) {
        this.pendingRequests.delete(data.id);
        reject(this.errorPayload(ex, `communicator.js, request`));
      }
    });
  }

  reply(event, code, payload, transferList) {
    let data = {
      id: event.data.id,
      code: code,
      payload: payload
    };

    this.target.postMessage(data, transferList);
  }

  errorPayload(error, location) {
    let message = error && error.message ? error.message : String(error);
    return { err: message, location: location };
  }

  rejectPending(error) {
    let payload = this.errorPayload(error, `communicator.js, connection`);
    for (let pending of this.pendingRequests.values())
      pending.reject(payload);
    this.pendingRequests.clear();
  }

  handleMessage(event) {
    if (!event || !event.data || typeof event.data !== "object")
      return;

    const data = event.data;
    let pending = this.pendingRequests.get(data.id);
    if (pending && (data.code === Communicator.SUCCESS ||
                    data.code === Communicator.FAILURE)) {
      this.pendingRequests.delete(data.id);
      if (data.code === Communicator.SUCCESS)
        pending.resolve(data.payload);
      else
        pending.reject(data.payload);
      return;
    }

    if (data.code !== Communicator.REQUEST && data.code !== Communicator.POST)
      return;

    const validPayload = data.payload &&
      typeof data.payload === "object" &&
      typeof data.payload.cmd === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(data.payload.cmd) &&
      (data.payload.params === undefined ||
       (data.payload.params !== null &&
        typeof data.payload.params === "object"));
    if (!validPayload) {
      if (data.code === Communicator.REQUEST &&
          (typeof data.id === "number" || typeof data.id === "string")) {
        this.reply(
          event,
          Communicator.FAILURE,
          this.errorPayload(
            "Malformed request.",
            `communicator.js, handleMessage`
          )
        );
      }
      return;
    }

    let self = this;
    if (data.code === Communicator.REQUEST) {
      let handler = this.messageHandler[data.payload.cmd];
      if (typeof handler !== "function") {
        this.reply(
          event,
          Communicator.FAILURE,
          this.errorPayload(
            `Unknown command: ${data.payload.cmd}`,
            `communicator.js, handleMessage`
          )
        );
        return;
      }

      try {
        Promise.resolve(handler(data.payload.params))
          .then(res => {
            if (!res ||
                (res.code !== Communicator.SUCCESS &&
                 res.code !== Communicator.FAILURE))
              throw new Error("Message handler returned an invalid response.");
            self.reply(event, res.code, res.payload, res.transferList);
          })
          .catch(err => {
            try {
              self.reply(
                event,
                Communicator.FAILURE,
                self.errorPayload(err, `communicator.js, handleMessage`)
              );
            } catch (replyError) {
              console.error(replyError);
            }
          });
      } catch (ex) {
        self.reply(
          event,
          Communicator.FAILURE,
          self.errorPayload(ex, `communicator.js, handleMessage`)
        );
      }
    } else if (data.code === Communicator.POST) {
      let handler = this.messageHandler[data.payload.cmd];
      if (typeof handler !== "function") {
        console.error(`Unknown command: ${data.payload.cmd}`);
        return;
      }
      Promise.resolve(handler(data.payload.params))
        .catch(err => console.error(this.errorPayload(err, `communicator.js, handleMessage`)));
    }
  }
}
