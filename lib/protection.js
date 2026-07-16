function buildProtectionHandlers() {
  const notImplemented = (_req, res) => res.status(501).json({ error: "not_implemented" });
  return {
    getInvitePolicy: notImplemented,
    getSlugPolicy: notImplemented,
    postSetupIntent: notImplemented,
    postNoShow: notImplemented,
    postWaive: notImplemented,
  };
}

module.exports = { buildProtectionHandlers };
