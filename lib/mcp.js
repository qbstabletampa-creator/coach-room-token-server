// lib/mcp.js
//
// The MCP endpoint for CoachTime's open API (build brief: feat/open-api-mcp).
// A coach adds `<server>/mcp` to Claude (or any MCP client) with their API key
// as the Bearer token, and their AI can drive their coaching business through
// the SAME tenant-locked core the /api/v1 REST surface uses.
//
// TRANSPORT: Streamable HTTP in STATELESS mode (no session id). One fresh
// McpServer + transport per request, so nothing leaks between coaches and each
// request is independently authed. The tools close over the authenticated
// coachId, so every tool call is tenant-locked exactly like the REST surface.
//
// LANDMINE (build brief #3): express.json() at index.js would consume the MCP
// body before the transport reads it. index.js mounts this handler with its OWN
// express.json() BEFORE the global one (the Stripe raw-body carve-out pattern),
// and we hand transport.handleRequest the already-parsed req.body.
//
// require() of the ESM SDK works under Node >= 22 (this box is v24). Verified at
// build time.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// JSON-RPC 2.0 error envelope for the pre-transport failures (auth). Once the
// transport is handling the request it writes its own JSON-RPC responses.
function jsonRpcError(code, message, id = null) {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

// Wrap a { status, data } core result into an MCP tool result. A >=400 status
// is surfaced as an MCP tool error (isError) so the AI sees the failure, with
// the structured body as text for it to read.
function toolResult({ status, data }) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    isError: status >= 400,
  };
}

// Shared optional paging shape.
const pageShape = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};
const protectionFeeShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none"), value: z.literal(0) }),
  z.object({ type: z.literal("flat"), value: z.number().int().min(0).max(10000000) }),
  z.object({ type: z.literal("percent"), value: z.number().min(0).max(100) }),
]);

/**
 * Build a stateless McpServer whose tools are bound to ONE coach. Every tool is
 * a thin wrapper over the tenant-locked apiCore, passing the server-derived
 * coachId (never anything from the client).
 */
function buildMcpServer({ apiCore, coachId }) {
  const server = new McpServer({ name: "coachtime", version: "1.0.0" });

  const reg = (name, config, handler) =>
    server.registerTool(name, config, async (args = {}) =>
      toolResult(await handler(args)),
    );

  // ---- athletes ----
  reg(
    "list_athletes",
    {
      title: "List athletes",
      description:
        "List the athletes on your roster (your tenant only). Supports limit (max 100) and offset for pagination.",
      inputSchema: { ...pageShape },
    },
    (a) => apiCore.listAthletes({ coachId, limit: a.limit, offset: a.offset }),
  );

  reg(
    "get_athlete",
    {
      title: "Get an athlete",
      description:
        "Fetch a single athlete by id. Returns 404 if the athlete is not on your roster.",
      inputSchema: { id: z.string().describe("athlete uuid") },
    },
    (a) => apiCore.getAthlete({ coachId, id: a.id }),
  );

  reg(
    "create_athlete",
    {
      title: "Create an athlete",
      description:
        "Add an athlete to your roster. `name` is required; position, age, school, goals, and parent_name/phone/email are optional.",
      inputSchema: {
        name: z.string().describe("athlete name (required)"),
        position: z.string().optional(),
        age: z.number().int().optional(),
        school: z.string().optional(),
        goals: z.string().optional(),
        parent_name: z.string().optional(),
        parent_phone: z.string().optional(),
        parent_email: z.string().optional(),
      },
    },
    (a) => apiCore.createAthlete({ coachId, input: a }),
  );

  reg(
    "update_athlete",
    {
      title: "Update an athlete",
      description:
        "Update fields on one of your athletes. Provide the id plus any of: name, position, age, school, goals, parent_name/phone/email.",
      inputSchema: {
        id: z.string().describe("athlete uuid"),
        name: z.string().optional(),
        position: z.string().optional(),
        age: z.number().int().optional(),
        school: z.string().optional(),
        goals: z.string().optional(),
        parent_name: z.string().optional(),
        parent_phone: z.string().optional(),
        parent_email: z.string().optional(),
      },
    },
    (a) => {
      const { id, ...rest } = a;
      return apiCore.updateAthlete({ coachId, id, input: rest });
    },
  );

  // ---- sessions ----
  reg(
    "list_sessions",
    {
      title: "List sessions",
      description:
        "List coaching sessions in your tenant. Optionally filter by athlete_id. Supports limit/offset.",
      inputSchema: { athlete_id: z.string().optional(), ...pageShape },
    },
    (a) =>
      apiCore.listSessions({ coachId, athleteId: a.athlete_id, limit: a.limit, offset: a.offset }),
  );

  reg(
    "get_session",
    {
      title: "Get a session",
      description: "Fetch a single session by id. 404 if it is not in your tenant.",
      inputSchema: { id: z.string().describe("session uuid") },
    },
    (a) => apiCore.getSession({ coachId, id: a.id }),
  );

  // ---- slots ----
  reg(
    "list_slots",
    {
      title: "List bookable slots",
      description:
        "List your bookable slots. Optional status filter: open, booked, cancelled, or completed. Supports limit/offset.",
      inputSchema: {
        status: z.enum(["open", "booked", "cancelled", "completed"]).optional(),
        ...pageShape,
      },
    },
    (a) => apiCore.listSlots({ coachId, status: a.status, limit: a.limit, offset: a.offset }),
  );

  reg(
    "generate_slots",
    {
      title: "Generate open slots",
      description:
        "Expand your active availability windows into concrete open slots for the next N weeks (1-12, default 4). Idempotent: re-running skips slots that already exist.",
      inputSchema: { weeks: z.number().int().min(1).max(12).optional() },
    },
    (a) => apiCore.generateSlots({ coachId, weeks: a.weeks }),
  );

  // ---- bookings ----
  reg(
    "list_bookings",
    {
      title: "List bookings",
      description: "List your booked slots (status = booked). Supports limit/offset.",
      inputSchema: { ...pageShape },
    },
    (a) => apiCore.listBookings({ coachId, limit: a.limit, offset: a.offset }),
  );

  reg(
    "cancel_booking",
    {
      title: "Cancel a booking",
      description:
        "Cancel a booked slot on your calendar by slot_id. Refunds one session credit to the originating purchase when there was one, and notifies the athlete.",
      inputSchema: { slot_id: z.string().describe("booked slot uuid") },
    },
    (a) => apiCore.cancelBooking({ coachId, slotId: a.slot_id }),
  );

  // ---- packages + credits ----
  reg(
    "list_packages",
    {
      title: "List packages",
      description: "List your session-credit packages (your catalog).",
      inputSchema: {},
    },
    () => apiCore.listPackages({ coachId }),
  );

  reg(
    "get_credit_balances",
    {
      title: "Get credit balances",
      description:
        "Get live session-credit balances per athlete (active purchases). Optionally narrow to one athlete_id.",
      inputSchema: { athlete_id: z.string().optional() },
    },
    (a) => apiCore.getCreditBalances({ coachId, athleteId: a.athlete_id }),
  );

  // ---- invites ----
  reg(
    "send_invite",
    {
      title: "Send a booking invite",
      description:
        "Mint a single-use, 14-day booking invite link. Optionally pre-assign athlete_id and/or slot_id (must be yours) and attach an email. Returns the token and the /book URL to share.",
      inputSchema: {
        athlete_id: z.string().optional(),
        slot_id: z.string().optional(),
        email: z.string().optional(),
      },
    },
    (a) => apiCore.createInvite({ coachId, input: a }),
  );

  reg(
    "list_invites",
    {
      title: "List invites",
      description: "List your booking invites (pending/accepted/expired). Supports limit/offset.",
      inputSchema: { ...pageShape },
    },
    (a) => apiCore.listInvites({ coachId, limit: a.limit, offset: a.offset }),
  );

  // ---- protection ----
  reg("get_protection_policy", { title: "Get protection policy", description: "Read your default protection policy and service overrides.", inputSchema: {} },
    () => apiCore.getProtectionPolicy({ coachId }));
  reg("set_protection_policy", { title: "Set protection policy", description: "Set your default or service-specific booking protection policy.", inputSchema: {
    session_type_id: z.string().optional(), enabled: z.boolean(), require_card: z.boolean().optional(),
    free_cancel_hours: z.number().int().min(0).max(168),
    late_cancel_fee: protectionFeeShape,
    no_show_fee: protectionFeeShape,
    booking_approval: z.boolean().optional(),
  } }, (a) => apiCore.setProtectionPolicy({ coachId, input: a }));
  reg("list_booking_charges", { title: "List booking charges", description: "List protection fee charges, optionally filtered by status or athlete.", inputSchema: {
    status: z.string().optional(), athlete_id: z.string().optional(), ...pageShape,
  } }, (a) => apiCore.listBookingCharges({ coachId, status: a.status, athleteId: a.athlete_id, limit: a.limit, offset: a.offset }));
  reg("charge_no_show", { title: "Charge no-show", description: "Mark an eligible booked slot as a no-show and charge its fee.", inputSchema: { slot_id: z.string() } },
    (a) => apiCore.chargeNoShow({ coachId, slotId: a.slot_id }));
  reg("waive_charge", { title: "Waive charge", description: "Waive or refund one of your booking charges.", inputSchema: { charge_id: z.string() } },
    (a) => apiCore.waiveCharge({ coachId, chargeId: a.charge_id }));

  // ---- billing ----
  reg("create_billing_plan", { title: "Create billing plan", description: "Set a package billing shape and cadence.", inputSchema: {
    package_id: z.string(), billing_type: z.enum(["one_time", "subscription", "installment"]),
    billing_interval: z.enum(["week", "month", "year"]).optional(), installment_count: z.number().int().min(2).max(120).optional(),
    auto_renew: z.boolean().optional(), max_cycles: z.number().int().min(1).max(120).optional(), carry_forward: z.boolean().optional(),
    trial_days: z.number().int().min(0).max(365).optional(), grace_days: z.number().int().min(0).max(90).optional(),
  } }, (a) => { const { package_id, ...input } = a; return apiCore.createBillingPlan({ coachId, packageId: package_id, input }); });
  reg("list_subscriptions", { title: "List subscriptions", description: "List your athlete subscriptions and next charges.", inputSchema: { ...pageShape } },
    (a) => apiCore.listSubscriptions({ coachId, limit: a.limit, offset: a.offset }));
  reg("get_subscription", { title: "Get subscription", description: "Get one athlete subscription and grace state.", inputSchema: {
    subscription_id: z.string().optional(), athlete_id: z.string().optional(),
  } }, (a) => apiCore.getSubscription({ coachId, subscriptionId: a.subscription_id, athleteId: a.athlete_id }));
  for (const action of ["pause", "resume", "cancel"]) {
    reg(`${action}_subscription`, { title: `${action[0].toUpperCase()}${action.slice(1)} subscription`, description: `${action[0].toUpperCase()}${action.slice(1)} one of your athlete subscriptions.`, inputSchema: {
      subscription_id: z.string(), ...(action === "cancel" ? { when: z.string().optional() } : {}),
    } }, (a) => apiCore.changeSubscription({ coachId, subscriptionId: a.subscription_id, action, when: a.when }));
  }

  // ---- dashboard + payments ----
  reg("get_dashboard", { title: "Get dashboard", description: "Read your revenue, bookings, open slots, attention items, and sources.", inputSchema: { range: z.string().optional() } },
    (a) => apiCore.getDashboard({ coachId, range: a.range }));
  reg("get_payments_overview", { title: "Get payments overview", description: "Read collected and owed totals with your payment ledger.", inputSchema: { range: z.string().optional(), ...pageShape } },
    (a) => apiCore.getPaymentsOverview({ coachId, range: a.range, limit: a.limit, offset: a.offset }));
  reg("record_payment", { title: "Record payment", description: "Record money collected from an athlete.", inputSchema: {
    amount_cents: z.number().int().positive(), collected_via: z.string(), athlete_id: z.string().optional(), slot_id: z.string().optional(),
    purchase_id: z.string().optional(), charge_id: z.string().optional(), note: z.string().optional(), occurred_at: z.string().optional(),
  } }, (a) => apiCore.recordPayment({ coachId, input: a }));
  reg("void_payment", { title: "Void payment", description: "Void one of your recorded payments.", inputSchema: { payment_id: z.string() } },
    (a) => apiCore.voidPayment({ coachId, paymentId: a.payment_id }));
  reg("create_charge", { title: "Create charge", description: "Record an amount an athlete owes.", inputSchema: {
    label: z.string(), amount_cents: z.number().int().min(0), athlete_id: z.string().optional(), slot_id: z.string().optional(),
  } }, (a) => apiCore.createCharge({ coachId, input: a }));

  // ---- imports + public page + clips ----
  reg("import_athletes", { title: "Import athletes", description: "Import up to 500 roster rows using the standard dedupe parser.", inputSchema: {
    rows: z.array(z.object({ name: z.string(), parent_email: z.string().optional(), parent_phone: z.string().optional(), parent_name: z.string().optional(), position: z.string().optional() })).max(500),
    options: z.record(z.string(), z.unknown()).optional(),
  } }, (a) => apiCore.importAthletes({ coachId, rows: a.rows, options: a.options }));
  reg("get_coach_page", { title: "Get coach page", description: "Read your sanitized public coach page and claim state.", inputSchema: {} },
    () => apiCore.getCoachPage({ coachId }));
  reg("list_clips", { title: "List clips", description: "List metadata for clips in your session library.", inputSchema: { ...pageShape } },
    (a) => apiCore.listClips({ coachId, limit: a.limit, offset: a.offset }));
  reg("get_clip_url", { title: "Get clip URL", description: "Mint a short-lived signed URL for one of your clips.", inputSchema: { clip_id: z.string() } },
    (a) => apiCore.getClipUrl({ coachId, clipId: a.clip_id }));

  return server;
}

/**
 * Build the Express handler for POST /mcp. Auth is the coach API key (Bearer);
 * it runs the SAME requireApiKey the REST surface uses, so the MCP surface is
 * tenant-locked identically. On success it sets req.apiKey so index.js's audit
 * hook records the call. deps: { requireApiKey, apiCore }.
 */
function buildMcpHandler({ requireApiKey, apiCore, onRequestAuthed }) {
  return async function mcpHandler(req, res) {
    // ---- AUTH: coach API key, same primitive as /api/v1 --------------------
    const authd = await requireApiKey(req);
    if (authd.error) {
      const id = (req.body && req.body.id) || null;
      return res.status(authd.status).json(jsonRpcError(-32001, authd.error, id));
    }
    req.apiKey = authd.apiKey; // for the audit hook wired in index.js
    const coachId = authd.apiKey.coachId;
    // Let index.js attach its audit-on-finish hook now that the key is known,
    // so an MCP call is audited exactly like a REST call.
    if (typeof onRequestAuthed === "function") {
      try {
        onRequestAuthed(req, res, authd.apiKey);
      } catch {
        /* audit wiring must never break the request */
      }
    }

    // Fresh server + transport per request (stateless). The tools close over
    // this coachId, so nothing crosses tenants.
    const server = buildMcpServer({ apiCore, coachId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session persistence
    });

    // Tear down when the response closes so we never leak a server/transport.
    res.on("close", () => {
      try {
        transport.close();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
    });

    try {
      await server.connect(transport);
      // Hand the transport the ALREADY-PARSED body (index.js parsed it with a
      // route-scoped express.json before the global one). The transport writes
      // the JSON-RPC response(s) to res itself.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "internal error"));
      }
    }
  };
}

// GET/DELETE on /mcp are only meaningful in stateful (session) mode. We are
// stateless, so answer a clean JSON-RPC "method not allowed" instead of 404.
function mcpMethodNotAllowed(_req, res) {
  res.status(405).json(jsonRpcError(-32000, "method not allowed (stateless MCP: use POST)"));
}

module.exports = { buildMcpHandler, buildMcpServer, mcpMethodNotAllowed };
