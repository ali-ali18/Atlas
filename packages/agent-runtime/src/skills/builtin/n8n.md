---
name: Workflows do n8n
description: How to build and edit n8n workflows through the n8n connector (instance-level MCP) — read the SDK reference, find nodes, validate, create, update, publish, and what to do about the Error workflow setting.
when: Read before creating or changing an n8n workflow through the n8n connector, or when an n8n tool asks for SDK code you have not seen.
groups: []
version: 2
---

# n8n workflows through the connector

The n8n connector exposes the instance-level MCP server. The tool set depends on the n8n version (workflow building needs 2.13+; some tools are newer), so list the connector's tools first (mcp_tool_search with the connector name) and use the names you actually see. Never write workflow code before reading the reference below: the code format is a specific SDK, not plain n8n JSON.

## Build a new workflow

1. Read the reference: call `get_workflow_sdk_reference`. The full text is long and may be cut; if so, call it again with `section` (`patterns`, `expressions`, `functions`, `rules`, `import`, `guidelines`) for the part you need. Optionally `get_workflow_best_practices` (`technique: "list"` shows the options).
2. Find the nodes: `search_nodes` with a few queries (e.g. "error trigger", "http request"). Then `get_node_types` with the node ids it returned, to get the exact parameters and versions. Use `explore_node_resources` only for dropdown values that need a credential (channels, sheets).
3. Write the code following the reference, then `validate_workflow` with the full code. If `valid` is false, read `errors` and `hint`, fix, validate again. Do not create before it is valid.
4. `create_workflow_from_code` with the validated code (and a `name`; `projectId`/`folderId` only if the user asked). Keep the returned `workflowId` and `url`.
5. Check the result: `warnings`, `autoAssignedCredentials`, `skippedGroups`. Credentials are auto-assigned when possible; an HTTP Request node that needs auth must be configured by the user.
6. Test when it makes sense: `prepare_workflow_pin_data` + `test_workflow`, or `execute_workflow`. Then `publish_workflow` only if the user wants it active.

## Edit an existing workflow

`search_workflows` to find it, `get_workflow_details` to read it, then `update_workflow` with `operations` (addNode, addConnection, setNodeParameter, setNodeSettings, rename, remove...). Changes apply atomically. For a rewrite use the SDK path (validate first). `get_workflow_history` / `restore_workflow_version` undo mistakes.

## Error workflow (the "Error workflow" setting of another workflow)

- The error workflow itself is a normal workflow whose first node is the Error Trigger, followed by what to do (e.g. HTTP Request, method POST, URL of the webhook, JSON body with workflow name, execution url and error message from the trigger data). Build it with the steps above.
- Linking it to another workflow is a workflow setting (`settings.errorWorkflow`). According to the n8n tools reference, `update_workflow` only changes node-level settings and name/description (`setWorkflowMetadata`), and the SDK reference should be checked for a settings field — read it before saying it is impossible. If neither exposes it, do not claim it was linked.
- Alternatives, in order: (a) if the user gave an n8n API key and you have an HTTP tool, update the workflow settings through the public API (`PUT /api/v1/workflows/{id}` with `settings.errorWorkflow` set to the error workflow id, keeping the other fields); (b) otherwise give the user the one manual step: open the workflow, Settings (three dots menu) > Error workflow > pick the created workflow > Save. Give the workflow name and id so it is quick.
- Say clearly what you created, its id/url, and which single step is left.

## Calling a routine webhook from n8n (never ask the user to paste a secret)

When a workflow must trigger one of the user's routines (an HTTP Request node pointing at a routine webhook, or an Error workflow that notifies a routine):

1. Call `routine_webhook_info`. It returns each routine's URL WITHOUT the secret, the header `X-Atlas-Hook-Secret` and a marker like `{{secret:rotina:<slug>}}`.
2. In the HTTP Request node: Method POST, URL exactly as listed (no `?secret=`), send headers with `X-Atlas-Hook-Secret` = the marker, JSON body.
3. Write the marker literally in the code you pass to `validate_workflow` / `create_workflow_from_code` / `update_workflow`. The runtime replaces it with the real secret only on the call to n8n and hides it in the results; you never see it. The approval card tells the user "the secret of routine X will be saved in n8n" (it lives only in their n8n).
4. If the tool says the routine secret is unavailable (older routine), ask the user to press "Gerar novo segredo" in the routine panel, then repeat. If the user already pasted a secret or a URL with `?secret=` in the chat, do not reuse it; use the marker and suggest rotating that secret.

## Rules

- Say what you will build before creating it when the request is ambiguous (trigger, destination URL, credentials).
- Do not put secrets in the workflow code; use credentials.
- A tool result that is cut: fetch the missing part (section, filters) instead of guessing.
- Only hand manual steps to the user after the tools truly offer no path, and then name the exact step.
