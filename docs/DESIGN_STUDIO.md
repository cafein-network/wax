# B1 design studio and per-project checks

**English** · [한국어](./DESIGN_STUDIO.ko.md)

On the dashboard's first screen, choose a Roblox game, a shopping-mall AI lookbook or a general project under **What are you building?**. The default is to detect it automatically from the request. The chosen type is fixed on the new request, and the current mission, room and required checks are shown. If you pick the wrong type, you can change it in a new request. Existing records do not have their type changed retroactively.

The 1F meeting room sets the goal, runtime environment, small scope and completion criteria. The B1 design studio makes previews and hands them to development. The 2F development room connects small flows, the 3F lab reviews real runs and screens, and the 4F CEO's office reports results and remaining work. A session working on design also stays at its own desk instead of going down to B1, and design content is passed on by note. The entrance and the existing floor numbers stay the same.

Registered previews and current jobs can be viewed from the design studio's moodboard or the **Design deliverables** button. Preview images are displayed, and HTML is previewed in a sandbox that blocks scripts, forms and external requests. Interaction checks must be done in the real target app. Blender and Studio files are downloaded and checked in those tools. Only files of 20 MiB or less inside the registered project are served.

The drink corners of the design studio, meeting room, development room and lab are set up the same way: a water dispenser, paper cups and a coffee machine on a cabinet. The 3 seats at the design studio workbench and the 5 open seats in the development room use the same folding chairs as the open seats in the meeting room.

## Verify from a small result

| Type | Design deliverable | Implementation check | Review check |
| --- | --- | --- | --- |
| Roblox | Preview or blockout of movement paths, controls and rewards | Run a small game loop in Studio | Play flow; controls, camera, collision and screens |
| AI lookbook | Previews of upload, waiting, failure and editing screens | Integrate from real generation through to its own storage | Generation, storage and reconnecting; product rendering comparison; editing, product links and mobile |

SM mode does not require new previews, and runs and regression checks within the maintenance scope. General projects follow the existing check rules and repository conventions. Multiplayer features in Roblox are checked with several clients, and for the lookbook the guidance is to keep the generation job ID so reconnecting does not send duplicate requests.

Use Figma for screen design, APIs such as FASHN for try-on images, Blender for any 3D models needed, and Midjourney and similar for backgrounds and props. WAX does not install or automatically connect these tools. The assigned AI must confirm the actual connection, authentication and how to run them, and must not report a tool it cannot use as connected.

## Recording evidence

Terminal tasks can set the type with `start ... --type roblox` or `--type lookbook`. If omitted, it is detected from the title and description. `status` and `prompt` show the current required item IDs and type.

```sh
wax test <id> --revision <revision> --verification runtime --checks play-loop -- <real check program> <arguments>
wax complete implement <id> --revision <latest revision> --evidence <result> --proofs <proof ID> --checks-file <checks.json>
```

`checks.json` is an array in the following format. Automatic requests return the same array in the `checks` of the AI report.

```json
[{"id":"play-loop","status":"pass","detail":"실제로 확인한 시나리오·결과","artifact":"","proofIds":["현재 단계의 실제 근거 ID"]}]
```

`preview` requires a real preview file at a project-relative path. `visual` requires a comparison or review capture and a `visual` run proof. `runtime` and `integration` require a passing proof recorded with the same item ID and check type. Proofs that failed, timed out, or come from an earlier stage or an earlier improvement cycle cannot pass. Required previews and behavior cannot be replaced by explanatory documents or by syntax or file-existence checks.

If review reports `fail`, the request shows **Fix and retest**. Clicking it starts a new improvement cycle at the development stage and reviews with new proofs. `unverified` continues from the current stage after the environment or information is supplied.

Whoever runs the check must record the check type and scenario accurately. WAX checks the linked proof, its type, stage and whether it passed; it does not judge on its own what an executed command means, whether a game is fun, or how faithful an image is to the product. Running the real target tool and a visual review are required. Test fixtures are not proof of real Roblox play or FASHN API calls.

## Figma and Blender MCP collaboration

In **Design deliverables** in the B1 design studio, connect a design tool and carry the screens and props the CEO requested through making them in real Figma or Blender, review, revision, approval and handoff as one job.

1. **Connect the target**: for Figma, select the frame to work on and paste the link you get from "Copy link to selection" (including node-id). Other link values such as share tokens are not stored. For Blender, specify a relative path to a `.blend` file in this project and the scene and collection names. Work is created and edited only inside that collection, while that file is open in Blender.
2. **Check the connection**: the check really runs in the chosen execution tool. Codex reads the MCP server status and tool list from the app server and confirms the Figma frame, or the file and scene open in Blender, read-only. Claude Code can only see the connection status from `claude mcp list`, so the Blender target file is confirmed in the production session. Results are shown as not connected, authentication required, connection error, target mismatch, read-only, or read and write, together with the next action.
3. **Production and versions**: only a target that passed the check can be sent for production, and it is checked again right before production. For a Figma result, wax fetches the screen of the result frame directly from Figma and stores it; for a Blender result, the rendered PNG and exported model are confirmed in the project (Codex also re-reads the open file and collection) and kept as a version. An AI report alone never creates a version.
4. **Review and revision**: the CEO's revision notes continue as the next version in the same frame or the same collection. Earlier versions and the note history stay as they are. A report claiming a different frame was edited is not accepted as a version.
5. **Approval and handoff**: only a version the CEO approved is handed off to development. `docs/wax/design/<job ID>/handoff-v<version>.md` records the source link, the result node or object, the note history, the approved preview and the exported files, and this handoff is included in the prompts of later stages of the linked wax task.

| Execution tool | Figma | Blender |
| --- | --- | --- |
| Codex | Supported (connection and frame check, result screen received) | Supported (connection and open file check, result re-confirmed) |
| Claude Code | Not supported: wax cannot receive the result screen directly | Supported (connection status check, target file confirmed in the production session) |
| Gemini CLI, GitHub Copilot CLI, Antigravity CLI | Not supported: no way to check MCP connection status | Not supported |

MCP server registration and sign-in use each execution tool's own settings. wax stores no tokens or server environment variables, and records only server names, status and tool names. Writing to the Figma canvas requires the remote MCP server (`https://mcp.figma.com/mcp`), a Professional plan or higher, and edit permission on the file (according to Figma's official documentation, beta). Example: `codex mcp add figma --url https://mcp.figma.com/mcp`, then Allow access at sign-in. Confirmations for MCP tool runs in a Codex session are allowed once or denied with the execution approval card in the dashboard. MCP requests that need values entered are handled in the Codex app or terminal.

Only one design job can be in progress for the same target. Design runs are one at a time per project, and they use a lock separate from request runs, so neither blocks the other. Duplicate clicks and resends are processed once, and notes or approvals after the version was changed elsewhere are refused. After a stop or disconnection, **Continue making** resumes from the saved notes. Design studio records in the public demo are examples, not results of real MCP runs.

## B1 background and prop sources

Selected on 2026-10-17 from pictures made with an external image generation tool. The files used on the actual game screen are included in `web/office/side/`: `bg-studio.png` (background), `prop-design-desk.png` (pen display workbench), `prop-moodboard.png` (moodboard), `prop-softbox.png` (studio lighting).

The common production instructions were 16-bit pixel art matching the existing office, a side-scrolling front view, and no people or text. The background is a sage and teal underground studio in a 17:5 ratio, and the props were made as standalone objects on a white background. `scripts/import-studio-art.mjs` aligns the floor line of the source PNGs and makes the white background transparent. Inside the crossbars of the workbench, board and tripod, the background is additionally removed in confirmed empty areas, while the board's paper and the lighting panel are preserved. Existing sources and furniture are not overwritten.
