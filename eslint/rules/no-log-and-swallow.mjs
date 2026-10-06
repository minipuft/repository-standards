// A catch whose only effect is a log line turns a failure into a silent continue: the caller
// reports success while in-memory and persisted state diverge. Persistence throws; one
// boundary catches and owns the response. A catch that also returns, rethrows, or changes
// state has made a decision and is not reported.

const LOG_METHODS = new Set([
  "debug",
  "error",
  "fatal",
  "info",
  "log",
  "trace",
  "warn",
]);

const LOGGER_NAME = /^(console|_?log(ger)?)$/i;

function receiverName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }
  return null;
}

function isLogCall(statement) {
  if (statement.type !== "ExpressionStatement") return false;
  let expression = statement.expression;
  if (expression.type === "AwaitExpression") expression = expression.argument;
  if (expression.type === "ChainExpression") expression = expression.expression;
  if (expression.type !== "CallExpression") return false;
  const callee = expression.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property.type !== "Identifier") return false;
  if (!LOG_METHODS.has(callee.property.name)) return false;
  const receiver = receiverName(callee.object);
  return receiver !== null && LOGGER_NAME.test(receiver);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Error and state boundaries: a catch block that only logs swallows the failure; rethrow or return it to the boundary that owns the response — from architecture.md §Error & State Boundaries",
    },
    schema: [],
    messages: {
      logAndSwallow:
        "This catch only logs, so the failure becomes a silent continue and the caller sees success. Rethrow, return a failure the caller checks, or let it propagate to the one boundary that owns the response.",
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const statements = node.body.body;
        if (statements.length === 0) return; // no-empty owns the empty catch
        if (!statements.every(isLogCall)) return;
        context.report({ node, messageId: "logAndSwallow" });
      },
    };
  },
};
