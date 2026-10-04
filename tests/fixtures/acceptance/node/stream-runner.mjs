import { run } from "node:test";

const file = new URL("./stream-probe.test.mjs", import.meta.url).pathname;
const stream = run({ files: [file], concurrency: true });
for await (const event of stream) {
  const payload = event.data ?? event;
  const details = payload.details;
  const error = details?.error;
  const cause = error?.cause;
  const data = {
    ...payload,
    ...(details === undefined ? {} : {
      details: {
        ...details,
        ...(error === undefined ? {} : {
          error: {
            name: error.name,
            code: error.code,
            failureType: error.failureType,
            ...(cause === undefined ? {} : {
              cause: { name: cause.name, code: cause.code }
            })
          }
        })
      }
    }),
    ...(event.type === "test:fail" && cause?.code === "ERR_ASSERTION"
      ? { assertion: true }
      : {})
  };
  process.stdout.write(`${JSON.stringify({ type: event.type, data })}\n`);
}
