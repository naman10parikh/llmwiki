# Claude Connectors: complete architecture and engineering playbook

**Claude's Connectors are MCP (Model Context Protocol) servers — remote or local — that Claude connects to through Anthropic's cloud infrastructure, enabling it to read data from and take actions within external services like Google Calendar, Gmail, Slack, and 50+ others.** The system launched in May 2025 as "Integrations" and was rebranded to "Connectors." It represents Anthropic's productization of MCP, the open protocol they created in November 2024 and donated to the Linux Foundation in December 2025. Every connector is an MCP server at the protocol level, but Anthropic layers on a curated directory, OAuth brokering, tool permission controls, and a security architecture that isolates credentials in an external vault inaccessible to the model's execution sandbox.

This document reverse-engineers the entire system — from the user clicking "Connect" to the JSON-RPC message hitting a third-party MCP server — based on official Anthropic documentation, the MCP specification, security disclosures, the SDKs, and direct observation of live connector tool schemas.

---

## What Connectors are and how they relate to MCP

Anthropic defines Connectors as the feature that lets "Claude access your apps and services, retrieve your data, and take actions within connected services." The protocol underneath is MCP — an open standard based on JSON-RPC 2.0 that standardizes how LLM applications communicate with external tools and data sources, analogous to how the Language Server Protocol standardized IDE integrations.

The relationship is layered. **MCP is the open protocol; Connectors are the product feature built on it.** A "connector" in Claude's UI maps directly to an MCP server at the protocol level. There are two types: **remote connectors** (MCP servers hosted on the internet, accessed through Anthropic's cloud) and **local connectors** (MCP servers running on the user's machine via Claude Desktop's stdio transport). A third category, **interactive connectors**, extends standard connectors with MCP Apps — HTML/JS bundles rendered in sandboxed iframes within conversations for UI like dashboards or task boards.

Anthropic also offers an **MCP Connector** feature in its Messages API (beta header `anthropic-beta: mcp-client-2025-11-20`), letting API consumers connect to remote MCP servers directly without building their own MCP client code. The **Connectors Directory** at `claude.com/connectors`, launched July 2025, is a curated hub of reviewed MCP servers available across Free, Pro, Max, Team, and Enterprise plans.

Critically, most directory connectors are **built and hosted by third parties**, not Anthropic. Atlassian hosts its own MCP server at `mcp.atlassian.com`, Linear at `mcp.linear.app`, Sentry at `mcp.sentry.dev`, and so on. Anthropic's role is as the MCP client operator, directory curator, OAuth broker, and connection proxy. The exceptions are the **Google Workspace connectors** (Gmail, Google Calendar, Google Drive), which appear to be first-party Anthropic-built connectors with Anthropic-registered OAuth clients — they are not listed in the third-party directory but are available natively to all users.

---

## The user experience from discovery to disconnection

### Discovering and enabling a connector

Users find connectors through two paths. From a chat, they click the "Search and tools" button (or "+" button) on the lower left of the chat interface, select "Add connectors," and browse by category. From Settings, they navigate to **Settings → Connectors → Browse connectors**. The Connectors Directory presents each connector with a detail page showing use cases, read/write capabilities, and plan availability.

### The OAuth connection flow

When a user clicks "Connect" on a connector like Google Calendar, the following sequence executes:

1. Claude initiates an **OAuth 2.1 Authorization Code flow with PKCE**. Claude generates a `code_verifier`, hashes it to a `code_challenge`, and redirects the user to the service provider's OAuth consent screen (e.g., Google's account selection and permissions screen).
2. The user selects their account and reviews the requested permissions. For Google Workspace connectors, the OAuth screen shows email access permissions, but Anthropic states: "Claude only reads emails and creates drafts with your explicit approval. The send function is not enabled."
3. Upon consent, the provider redirects to Claude's OAuth callback URL: **`https://claude.ai/api/mcp/auth_callback`** (with `https://claude.com/api/mcp/auth_callback` as an alternate).
4. Claude exchanges the authorization code for access and refresh tokens, which are **encrypted and stored in a secure vault** on Anthropic's backend infrastructure.
5. The connector appears in the user's Settings → Connectors list, enabled for use.

Claude's OAuth client name is **"Claude"**, and Claude supports both the March 2025 (`2025-03-26`) and June 2025 (`2025-06-18`) MCP auth specifications. Claude also supports **Dynamic Client Registration (DCR)** — when a server supports it, Claude automatically registers as an OAuth client rather than requiring pre-configured credentials.

### Tool permissions and approval granularity

Each tool in a connector carries **annotations** — metadata hints that classify its behavior. Two critical annotations are `readOnlyHint: true` (the tool only reads data) and `destructiveHint: true` (the tool modifies or deletes data). These annotations drive the permission system:

- **Always allow**: Tools with `readOnlyHint: true` can be set to execute without user confirmation. Claude calls them automatically when relevant.
- **Needs approval**: Tools with `destructiveHint: true` or missing annotations prompt the user to confirm before execution. Claude shows the tool name, parameters, and asks for explicit approval.
- **Blocked**: Users or admins can disable specific tools entirely.

On Team and Enterprise plans, **organization owners can restrict write actions** across the entire org — allowing connectors to read data while preventing any writes back to the service. During Claude's **Research mode**, tools from enabled connectors execute automatically without per-call approval, since the research process involves many iterative tool calls.

Direct observation of the live tool schemas confirms this design. The Gmail connector exposes 7 tools — `gmail_get_profile`, `gmail_search_messages`, `gmail_read_message`, `gmail_read_thread`, `gmail_list_drafts`, `gmail_list_labels` (all read-only), and `gmail_create_draft` (write, but notably **not** `gmail_send_email`). The Google Calendar connector exposes 9 tools including both read (`gcal_list_events`, `gcal_get_event`, `gcal_find_my_free_time`, `gcal_find_meeting_times`) and write operations (`gcal_create_event`, `gcal_update_event`, `gcal_delete_event`, `gcal_respond_to_event`).

### Managing and disconnecting

Users manage connectors at **Settings → Connectors**, where they can disconnect individual services, modify settings, or review permissions. Disconnecting removes the encrypted tokens from Anthropic's systems but does **not** revoke tokens at the identity provider — access and refresh tokens remain valid until they expire naturally. Users who want full revocation should also visit the provider's security settings (e.g., `myaccount.google.com/connections` for Google or Microsoft Entra Admin Center for M365). Editing a custom connector requires removing it and re-adding with updated details.

---

## Authentication and authorization architecture in depth

### OAuth token lifecycle

Anthropic's architecture separates token storage from the model execution environment through what they call a **"structural fix."** The Anthropic engineering blog on managed agents describes the design:

> "For custom tools, we support MCP and store OAuth tokens in a secure vault. Claude calls MCP tools via a dedicated proxy; this proxy takes in a token associated with the session. The proxy can then fetch the corresponding credentials from the vault and make the call to the external service. The harness is never made aware of any credentials."

This creates a **two-hop isolation model**: the model's sandbox never touches real credentials. Even if the sandbox is compromised, an attacker gains nothing reusable. VentureBeat's analysis with NCC Group's Head of AI/ML Security validated this approach, calling it a "zero-trust agent architecture" and noting that "Anthropic removes credentials from the blast radius entirely."

**Token specifics vary by provider.** For Microsoft 365, access tokens expire within **60-90 minutes** (per Microsoft Entra ID defaults) and are automatically refreshed. Refresh tokens expire after **90 days of inactivity**. For Google Workspace, standard Google OAuth token lifetimes apply. All tokens are **encrypted while cached** by the Claude backend — third-party analyses cite AES-256 encryption at rest and TLS 1.2+ in transit, though Anthropic does not publicly specify cipher suites.

### Managed OAuth clients

Anthropic maintains **publisher-verified OAuth applications** registered with major providers. For Microsoft 365, two enterprise applications exist in Entra ID: "M365 MCP Client for Claude" (`08ad6f98-a4f8-4635-bb8d-f1a3044760f0`) and "M365 MCP Server for Claude" (`07c030f6-5743-41b7-ba00-0a6e85f37c17`). The M365 connector uses an **On-Behalf-Of (OBO)** flow where the MCP server exchanges the user's token for a Graph API token — meaning "not even the user or their Claude client has access to the OBO tokens."

For Google Workspace, Anthropic has a registered OAuth client that appears as "Claude" in Google's third-party app access management. Google Workspace admins can find and manage it at `admin.google.com → Security → API controls`. For third-party directory connectors, the connector developer manages their own OAuth client, and users can optionally provide custom client IDs and secrets in "Advanced settings."

### What Anthropic claims about employee access

Anthropic's Privacy Center states: "By default, Anthropic employees cannot access your conversations unless you explicitly consent to share data as feedback, or review is needed to enforce our Usage Policy." Technical enforcement includes **role-based access control (RBAC)**, just-in-time access with approval workflows, mandatory MFA for production systems, quarterly access reviews, and network segmentation. The vault-and-proxy architecture means tokens are architecturally inaccessible to internal systems outside the proxy path. Anthropic has **not publicly disclosed** whether HSMs or hardware security modules protect the vault's encryption keys.

---

## MCP protocol architecture powering Connectors

### Transport: Streamable HTTP

Claude Connectors use **Streamable HTTP**, the standard remote transport introduced in MCP spec version `2025-06-18`, replacing the older HTTP+SSE dual-endpoint transport. The server exposes a **single HTTP endpoint** (e.g., `/mcp`) handling three methods:

- **POST**: Receives JSON-RPC 2.0 messages (tool calls, initialization). The server responds with either `Content-Type: application/json` (single response) or `Content-Type: text/event-stream` (SSE stream for longer operations).
- **GET** (optional): Opens an SSE stream for server-initiated notifications like `notifications/tools/list_changed`.
- **DELETE**: Terminates the session.

Sessions are tracked via the **`Mcp-Session-Id` header**, assigned by the server during initialization and included by Claude on all subsequent requests. The protocol version is communicated via the `MCP-Protocol-Version` header (e.g., `2025-11-25`). This design works on serverless platforms (Cloudflare Workers, Vercel Edge Functions) because it doesn't require persistent connections. The older SSE transport still functions but is **deprecated** — the Connectors Directory requires Streamable HTTP for all new submissions.

### Tool schemas and how Claude discovers them

When Claude connects to an MCP server, it sends a `tools/list` JSON-RPC request. The server responds with an array of tool definitions, each containing a `name`, `description`, and `inputSchema` (JSON Schema format defining parameters). Direct observation of live connector tools reveals the naming convention: tools are namespaced as `mcp__<ServerName>__<tool_name>` (e.g., `mcp__Gmail__gmail_search_messages`, `mcp__Google_Calendar__gcal_create_event`).

The tool descriptions are remarkably detailed — typically **3-5 paragraphs** each, including usage examples, error handling guidance, pagination instructions, and explicit "Use when" / "Don't use when" examples. This density is intentional: Anthropic's engineering guidance states that tool descriptions should be "3-4+ sentence descriptions" because **description quality directly impacts tool selection accuracy**. Each tool's return type mentions "citation metadata for proper attribution," suggesting structured output with source tracking.

### How Claude selects which tools to call

Tool selection is a **model inference decision**, not hardcoded routing. When tools are available, the API injects their schemas into a special system prompt. Claude (the LLM) analyzes the user's request against available tool names, descriptions, and schemas, then decides which tool(s) to call and generates arguments. The `tool_choice` parameter controls behavior: `auto` (Claude decides), `any` (must use a tool), `tool` (force specific tool), or `none` (disable tools).

When many connectors are active, tool definitions can consume **10-20K tokens for 50 tools** — Anthropic has seen up to **134K tokens** before optimization. To mitigate this, Claude supports a **Tool Search Tool** with deferred loading. When `defer_loading: true` is set, tool descriptions are withheld from the initial context and Claude uses a search tool to discover relevant tools on-demand, adding one extra round-trip but dramatically reducing context consumption. In claude.ai, three access modes control this: "Auto" (Claude decides which connectors to load), "Always available" (all loaded upfront), and "On demand" (search-first).

### End-to-end request lifecycle

A complete tool call traverses this path:

1. User sends a message mentioning a connected service
2. Claude's inference identifies relevant tools from schemas in context
3. Claude generates a `tools/call` JSON-RPC request with tool name and arguments
4. The request is routed through Anthropic's **MCP proxy**, which retrieves the user's encrypted OAuth token from the vault
5. The proxy sends the authenticated request over Streamable HTTP POST to the MCP server's endpoint
6. The MCP server handler executes (calls Google API, Slack API, etc.) and returns a result
7. The result (max **25,000 tokens**) is returned to Claude's inference layer
8. Claude incorporates the tool result into its natural language response

Typical round trip takes **1-3 seconds**. The hard timeout is **300 seconds (5 minutes)** for claude.ai and Claude Desktop, configurable in Claude Code. All connections originate from **Anthropic's cloud infrastructure** — even when using Claude Desktop, remote connectors connect from Anthropic's servers, not the user's machine. Anthropic publishes static IP addresses for server operators to allowlist.

---

## Security and privacy model

### Data retention and training exclusions

Connector data follows the same retention as its associated chat: **30 days for consumer users who opt out of training**, up to **5 years for those who opt in**, and **30 days for Team/Enterprise** (unless otherwise agreed). Deleting a chat deletes the retrieved connector data. Connectors retrieve data **on-demand only** and do not cache file content.

A critical privacy distinction: **raw content from connectors is explicitly excluded from model training**, even for consumer users who opt into training. Anthropic states: "Feedback data does not include raw content from connectors (e.g., Google Drive), including remote and local MCP servers, though data may be included if it's directly copied into your conversation with Claude." For Google Workspace specifically: "We do not train our models on your Gmail or Calendar connector data." Team and Enterprise plans never use any data for training.

However, Anthropic does collect **telemetry** from connector usage: "Telemetry includes all parameters and data passed into tool calls as well as the response from MCP server."

### Compliance and certifications

Anthropic holds **SOC 2 Type I and Type II** (annual audit), **ISO 27001:2022**, **ISO/IEC 42001:2023** (AI Management Systems), and offers HIPAA-configurable deployments with BAAs. For GDPR, they provide DPAs and Standard Contractual Clauses for international transfers. SOC 2 reports are available under NDA via `trust.anthropic.com`. For Microsoft 365, Anthropic completed Microsoft's **publisher verification process**, and the connector uses cryptographically enforced multi-tenant isolation through digitally signed access tokens.

### Known security gaps

Several independent security assessments have identified issues. Cato CTRL found **two vulnerabilities in Anthropic's MCP SDK** related to OAuth (open redirect and CSRF-based attacks), which Anthropic acknowledged in September 2025. Harmonic Security identified that **Cowork activity doesn't appear in audit logs**, the Compliance API, or data exports — a gap for regulated industries. Blue Cycle Security noted that the API-level data path **bypasses endpoint DLP controls**: DLP agents watching browsers and proxies filtering outbound traffic don't see connector data flows because connections originate from Anthropic's infrastructure.

---

## Building your own connector

### Creating a remote MCP server

Any developer can build a custom MCP server and connect it to Claude. The minimum requirements: a publicly accessible HTTPS endpoint implementing the MCP protocol, specifically the Streamable HTTP transport. The official SDKs are available in **8 languages** — TypeScript (`@modelcontextprotocol/sdk`, 23.5M+ weekly npm downloads), Python (`mcp` on PyPI), plus Java, Kotlin, C#/.NET, Go, Rust, Ruby, and Swift.

A minimal Python MCP server:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("My Server")

@mcp.tool()
def my_tool(param: str) -> dict:
    """Tool description for Claude to understand when to call this."""
    return {"result": f"Processed {param}"}

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

### Getting listed in the Connectors Directory

To move from custom connector to directory listing, servers must meet stringent requirements: **production-ready status** (no beta), **tool annotations on every tool** (`readOnlyHint` or `destructiveHint` — missing annotations cause 30% of rejections), **OAuth 2.0** for authenticated servers, **valid HTTPS/TLS**, **Streamable HTTP transport**, a published **privacy policy** (missing = immediate rejection), **minimum 3 working examples** in documentation, a **dedicated support channel**, and a **test account** with sample data for Anthropic's review team. Servers must also allowlist Claude's OAuth callback URLs and CORS origins (`https://claude.ai`, `https://claude.com`, `https://www.anthropic.com`, `https://api.anthropic.com`).

Submission goes through the Connectors Directory server review form. Due to "overwhelming interest," Anthropic cannot guarantee acceptance or response timelines. Servers can be removed at Anthropic's discretion.

### Implementing OAuth in a custom MCP server

MCP's authorization follows **OAuth 2.1 with PKCE**. The server must implement:

1. **Protected Resource Metadata** (RFC 9728) at `/.well-known/oauth-protected-resource`, pointing to the authorization server
2. **Authorization Server Metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`
3. **PKCE flow** (RFC 7636): validate `code_verifier` against `code_challenge` during token exchange
4. **Resource Indicators** (RFC 8707): the `resource` parameter identifying the target MCP server must be included in auth and token requests

For testing, developers can use the **MCP Inspector** (`npx @modelcontextprotocol/inspector`) — a visual debugging tool that supports OAuth flows, tool invocation testing, and real-time JSON-RPC message logging at `http://localhost:6274`. The Inspector's OAuth callback is `http://localhost:6274/oauth/callback`. Cloudflare provides managed hosting with **built-in OAuth token management and autoscaling** at `developers.cloudflare.com/agents/guides/remote-mcp-server/`.

### Using MCP servers in the API

```python
response = client.beta.messages.create(
    model="claude-opus-4-6",
    max_tokens=1000,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{
        "type": "url",
        "url": "https://mcp.example.com/mcp",
        "name": "example-mcp",
        "authorization_token": "YOUR_OAUTH_TOKEN",
        "tool_configuration": {
            "enabled": True,
            "allowed_tools": ["tool1", "tool2"]
        }
    }],
    messages=[{"role": "user", "content": "Your prompt here"}]
)
```

API consumers handle the OAuth flow externally and pass the access token directly. Only tool calls are currently supported in the API connector (not resources or prompts).

---

## Key reference URLs and open-source resources

The ecosystem spans official specifications, SDKs, and community tools. The **MCP specification** lives at `modelcontextprotocol.io/specification/2025-11-25` (latest stable), with the authorization spec at `modelcontextprotocol.io/specification/2025-06-18/basic/authorization`. The **MCP Registry** at `registry.modelcontextprotocol.io` provides a REST API for server discovery (v0.1 API, frozen since October 2025). Reference server implementations — including Google Drive, Slack (47 tools), GitHub, PostgreSQL, Filesystem, and 50+ others — are at `github.com/modelcontextprotocol/servers`, all MIT-licensed.

Anthropic's connector documentation spans several key pages: the main connector guide at `support.anthropic.com/en/articles/11176164`, custom connector setup at `support.anthropic.com/en/articles/11175166`, the developer build guide at `support.anthropic.com/en/articles/11503834`, the directory FAQ at `support.anthropic.com/en/articles/11596036`, and the submission guide at `support.claude.com/en/articles/12922490`. The MCP Connector API documentation is at `platform.claude.com/docs/en/agents-and-tools/mcp-connector`. Anthropic's engineering blog post on managed agent architecture at `anthropic.com/engineering/managed-agents` is the most detailed public disclosure of the credential isolation architecture.

Community resources include the **MCP Inspector** (`github.com/modelcontextprotocol/inspector`, 9.4K+ stars), **FastMCP 2.0** (`gofastmcp.com`) for higher-level Python server development, **Smithery** (`smithery.ai`) and **PulseMCP** as community server directories, and **MCPB** (`github.com/anthropics/mcpb`) for bundling local desktop extensions. The protocol has reached approximately **97 million monthly SDK downloads** across all languages, with **13,000+ public MCP servers** on GitHub as of early 2026.

---

## Conclusion

Claude's Connectors system is fundamentally a well-engineered productization of the open MCP protocol, with three key architectural decisions that define its character. First, **all remote connections are brokered through Anthropic's cloud** — the user's machine never directly contacts MCP servers, enabling centralized security enforcement and credential isolation. Second, **OAuth tokens live in an external vault accessible only through a dedicated proxy**, creating structural impossibility (not just policy prohibition) of credential leakage from the model's execution sandbox. Third, **Anthropic positioned itself as curator rather than builder** — most connectors are third-party MCP servers that Anthropic reviews and lists, creating an ecosystem rather than a walled garden.

The most significant gap in the architecture is the absence of zero-data-retention (ZDR) support for connector data and the fact that telemetry captures full tool call parameters and responses. For regulated industries, the lack of Cowork audit trail visibility and the bypass of endpoint DLP controls represent material compliance considerations. Engineers building similar systems should adopt Anthropic's vault-and-proxy credential isolation pattern while addressing these audit and data governance gaps from the outset.
