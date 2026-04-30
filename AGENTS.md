# Project description

- podman-based CLI container orchestrator alternative to pm2
- Deno, SQlite, Kysely
- see [TODO.md](./TODO.md) for plans and notes on the project

# Code Requirements

- Write production-grade, typesafe and optimized code
- Make data flow linear and straightforward: no singletons, static classes, etc
- Prefer functions to classes
- Don't write defensive excess
- Put types right before their function/usage implementation
- Put types in files which own them, don't create type-only files

# Work Instructions

- You can split complex tasks into sub-tasks for sub-agents
- Don't yap, don't sugar-coat responses, don't write summaries. Keep your
  responses concise and useful
- Once finished, respond with shortest possible and concise recap

# Sub-Agent Policy

- If you use agents, do so wisely. Reuse agents which are done and have no job
- Don't wait for all agents to finish. Once some agents are done, validate their
  response and proceed further if not blocked by other agents
- Ensure agents are not co-dependent. Create agents for every independent
  sub-task of entire user request that can be done immediately without waiting
  or extra investigation. Don't run implementation agent if another agent is
  investigating something for it
