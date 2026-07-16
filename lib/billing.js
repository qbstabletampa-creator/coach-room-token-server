function buildBillingHandlers() {
  const notImplemented = (_req, res) => res.status(501).json({ error: "not_implemented" });
  return {
    getSubscriptions: notImplemented,
    postPause: notImplemented,
    postResume: notImplemented,
    postCancel: notImplemented,
  };
}

module.exports = { buildBillingHandlers };
