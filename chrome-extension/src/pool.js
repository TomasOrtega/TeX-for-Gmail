"use strict";

class Semaphore {
  name;
  capacity;
  availableNo;
  waits;
  destroyed;
  maxQueue;

  constructor(capacity, name, maxQueue = Infinity) {
    this.name = name;
    this.destroyed = false;
    this.capacity = capacity;
    this.availableNo = capacity;
    this.waits = [];
    this.maxQueue = maxQueue;
  }

  rejectAll() {
    while (this.waits.length > 0) {
      let waitReject = this.waits.pop()[1];
      waitReject(`Workpool ${this.name} already destroyed!`);
    }
  }

  destroy() {
    this.destroyed = true;
    this.rejectAll();
  }

  notifyWaits() {
    if (this.destroyed)
      this.rejectAll();

    while ((this.waits.length > 0) && (this.availableNo > 0)) {
      this.availableNo--;
      let waitResolve = this.waits.shift()[0];
      waitResolve(true);
    }
  }

  release() {
    this.availableNo++;
    this.notifyWaits();
  }

  acquire() {
    if (this.destroyed)
      return Promise.reject(`Workpool ${this.name} already destroyed!`);

    if (this.availableNo > 0) {
      this.availableNo--;
      return true;
    }

    if (this.waits.length >= this.maxQueue)
      return Promise.reject(new Error(`Workpool ${this.name} is busy.`));

    return new Promise((resolve, reject) => {
      this.waits.push([resolve, reject]);
    });
  }
}

class Pool {
  name;
  realPool; // actual resource. resourcePool takes into account multiplier
  resourcePool;
  semaphore;
  autoRelease;
  initialize;
  multiplier;
  cons;
  free;
  destroyed;
  replacements;

  constructor({
    name,
    count,
    cons,
    free,
    autoRelease,
    initialize,
    multiplier,
    maxQueue
  }) {
    this.destroyed = false;
    this.name = name;
    this.cons = cons;
    this.free = free ? free : (el) => { }; // free is optional
    this.initialize = initialize ? initialize : () => {};
    this.autoRelease = autoRelease;
    this.multiplier = multiplier ? multiplier : 1;
    this.semaphore = new Semaphore(count * this.multiplier, name, maxQueue);
    this.resourcePool = [];
    this.realPool = [];
    this.replacements = new Map();

    for (let i = 0; i < count; i++)
      this.realPool.push(cons());

    for (let j = 0; j < this.multiplier; j++)
      for (let i = 0; i < count; i++)
        this.resourcePool.push(this.realPool[i]);
  }

  destroy() {
    this.destroyed = true;
    this.semaphore.destroy();
    this.realPool.forEach(elt => this.free(elt));
    this.realPool = [];
    this.resourcePool = [];
    this.replacements.clear();
  }

  release(resource) {
    this.resourcePool.push(resource);
    this.semaphore.release();
  }

  retire(resource) {
    if (this.destroyed)
      return resource;

    let existing = this.replacements.get(resource);
    if (existing)
      return existing.resource;

    let index = this.realPool.indexOf(resource);
    if (index < 0)
      return resource;

    let replacement = this.cons();
    this.realPool[index] = replacement;
    let idleCopies = 0;
    this.resourcePool = this.resourcePool.map(current => {
      if (current !== resource)
        return current;
      idleCopies++;
      return replacement;
    });
    this.replacements.set(resource, {
      remaining: this.multiplier - idleCopies,
      resource: replacement
    });
    this.free(resource);
    return replacement;
  }

  replacementFor(resource) {
    let replacement = this.replacements.get(resource);
    if (!replacement)
      return resource;

    replacement.remaining--;
    if (replacement.remaining <= 0)
      this.replacements.delete(resource);
    return replacement.resource;
  }

  retireSafely(resource) {
    try {
      this.retire(resource);
    } catch {
      try {
        this.destroy();
      } catch {}
    }
  }

  async processHelper(task, options = {}) {
    let resource = this.resourcePool.pop();
    try {
      let work = async () => {
        await this.initialize(resource);
        if (this.destroyed)
          throw new Error(`Workpool ${this.name} already destroyed!`);
        return task(resource);
      };

      if (!(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0))
        return await work();

      let timer;
      let timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.retireSafely(resource);
          let error = new Error(
            options.timeoutMessage || `Workpool ${this.name} timed out.`
          );
          error.name = "TimeoutError";
          reject(error);
        }, options.timeoutMs);
      });
      try {
        return await Promise.race([work(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (ex) {
      if (options.retireOnError)
        this.retireSafely(resource);
      throw ex;
    } finally {
      if (this.autoRelease && !this.destroyed)
        this.release(this.replacementFor(resource));
    }
  }

  process(task, options) {
    if (this.destroyed)
      return Promise.reject(`Workpool ${this.name} already destroyed!`);

    let permit = this.semaphore.acquire();

    if (permit === true)
      return this.processHelper(task, options);
    else
      return permit.then(() => this.processHelper(task, options));
  }
}
