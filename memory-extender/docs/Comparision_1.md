Comprehensive Technical Study on the Marinara Extender Persistent Memory Architecture in the AI Agent Ecosystem
The evolution of artificial intelligence interaction interfaces (AI Frontends) from simple chatbot systems to agentic-first platforms demands revolutionary improvements in model state and memory management. Among modern platforms, Marinara Engine emerges as a powerful successor to SillyTavern due to its parallel multi-agent architecture and its ability to intervene deeply in the text processing flow. However, when roleplay or story-simulation scenarios extend to millions of tokens, traditional context management techniques based on static pruning queues expose clear drawbacks that degrade the long-term consistency of characters.
To radically solve this challenge, the Marinara Extender project was developed as a persistent external memory storage system, scientifically organizing partitions by scopes and data lanes. This study comprehensively analyzes the technical structure, operational principles, application programming interfaces (API) system, deeply contrasts them with leading world SOTA (State-Of-The-Art) AI memory management solutions, and proposes optimal development strategies for the future.
Historical Background and Ecosystem Positioning
The Marinara Engine ecosystem was developed by the Pasta-Devs group, an open-source organization focused on optimizing local inference and agent architectures. This interface is built primarily using TypeScript and is currently undergoing a major refactor to the Tauri framework to support cross-platform compatibility more optimally. Before Marinara Engine was born, developer SpicyMarinara established a significant reputation in the community through extensions such as RPG Companion for SillyTavern. This extension introduced the capability to track character states, scene info boxes (location, weather, timeline), and character inner thoughts.
When SpicyMarinara shifted toward building an independent interface, Marinara Engine, the features of RPG Companion were integrated directly into the core of the new tool as system agents running on three pipelines: pre-generation, parallel, and post-generation. In that context, Marinara Extender acts as an add-on operating at the post-generation stage.
It should be noted that in the GitHub open-source space, another project also named "Marinara" exists (developed by Chris Schmich under the MIT license, written in JavaScript, Vue, and Ruby). However, that tool is entirely a Chrome extension serving time management via the Pomodoro technique and has nothing to do with AI interaction. The Marinara Extender project studied here is a specialized external memory solution designed exclusively for Marinara Engine.
Operational Principles and the Sidecar Architecture Model
The architecture of Marinara Extender operates under an independent Sidecar model, including a local Node.js server and a thin extension loader embedded directly inside the user's client browser. This model ensures that all heavy computing logic and data storage are completely isolated from the interface rendering flow, optimizing latency and preventing memory leak issues.
┌────────────── Extender Sidecar Server (localhost:3001) ──────────────┐
│ - Extract [remember:] / [bookmark:] commands                         │ ◀── Client Extension (after chat turn)
│ - Analyze emotional & factual beats via internal model               │     Sends chat turn data
│ - Promote / Demote memory & archive old files                        │
│ - Construct <memory_system> + <memory> data blocks                  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼ Data Block
┌──────────────────────────────────────────────────────────────────────┐
│ Load 2 fixed Lorebook system entries (per character)                 │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ Loaded by Marinara each turn
                                   ▼
                      Next Text Generation Turn
System Boot and Installation Process
The system setup process is designed to minimize technical barriers through automated scripts. Users clone the source code from the official GitHub repository. On Windows operating systems, running the startup script automatically triggers the installation of dependent libraries, launches Ollama, downloads necessary models, and maintains an automated monitoring process that recovers when the server crashes. On macOS or Linux operating systems, the server is launched manually via Node.js version 20 or higher.
The client extension is installed through the dynamic loading mechanism of Marinara Engine. Users access the local setup page of the sidecar to download a small loader file. This file is then uploaded to the Marinara Engine interface. This mechanism complies with the declarative format of the extension configuration file to register JavaScript code running directly on the browser.
Post-Turn Data Processing Flow
When the AI character finishes generating a response, the client extension intercepts the result and executes a closed-loop transmission sequence:
•	Data Transmission: The entire chat turn content is sent back to the sidecar server via the REST API protocol.
•	Parsing: The sidecar server uses regular expressions to extract internal commands in the form of [bookmark: ...] or [remember: ...]. All these commands are stripped from the displayed text to preserve the aesthetic quality of the conversational interface.
•	Analytical Inference: The server forwards the conversation content to a local language model to extract objective facts and emotional transitions.
•	Lorebook Regeneration: Analytical results are compiled into two always-on Lorebook entries. These entries are inserted directly into the next text generation process of Marinara Engine.
Environment Variables and Flexible Configuration Mechanism
All behaviors of Marinara Extender can be adjusted directly via the environment configuration file located at the root directory of the project or through the configuration form on the setup interface. The variables are divided into two main groups: internal inference flow and system behavior control.
Environment Variable	Default Value	Detailed Description and System Role
MARINARA_EXTENDER_PORT	3001	Local network port bound by the sidecar server to serve API requests.
MARINARA_EXTENDER_DATA	Local data/ folder	Physical path on the hard drive used to store the entire YAML database.
MARINARA_EXTENDER_LOCAL_URL	http://127.0.0.1:11434/v1	OpenAI-compatible endpoint of the local inference server (Ollama is the default configuration).
MARINARA_EXTENDER_LOCAL_MODEL	dolphin3:8b	Language model responsible for scene summarization, fact extraction, and emotional analysis.
MARINARA_EXTENDER_EMBED_MODEL	None	Vector embedding model used for merging memory fragments with semantic similarity.
MARINARA_EXTENDER_API_KEY	None	Security key for third-party cloud providers used when the local system loses connection.
MARINARA_EXTENDER_DIGEST_UPSTREAM	https://api.openai.com	Fallback cloud API server when local inference cannot be executed.
MARINARA_EXTENDER_DIGEST_MODEL	gpt-4o-mini	Lightweight cloud model designated to handle fallback summarization tasks.
MARINARA_RWA_PATH	None	Path linking to the source code file of the local Rewrite Assistant extension.
MARINARA_EXTENDER_TIMESENSE	0	Configuration to activate simulated time sense in the plot (disabled by default in version 1.0).
MARINARA_EXTENDER_EIDETIC	0	Experimental mode forcing all memories to load into the context regardless of budget limits.
MARINARA_EXTENDER_BUDGET_CHAT	4000	Maximum token capacity limit reserved for the current chat memory scope.
MARINARA_EXTENDER_BUDGET_CHARACTER	2000	Maximum token budget allocated for persistent character information.
MARINARA_EXTENDER_BUDGET_GLOBAL	1000	Maximum token budget for general world settings.

These token budget values are reread directly from the disk by the system after each chat turn. This allows users to change memory capacity on the fly during conversations without restarting the sidecar server. When the total budget exceeds the Lorebook loading limit in Marinara Engine (configured by default at 16,384 tokens), the main engine will automatically discard entries. Therefore, the default total configured capacity of around 7,000 tokens is an optimal design to avoid sudden memory loss.
Layered Architecture and Memory Decay Mechanism
The memory architecture of Marinara Extender is organized into a two-dimensional grid structure, combining spatial scopes and functional data lanes to achieve high accuracy in information retrieval.
┌────────────────────────────────────────┐
│           Global Scope (1k)            │
│  (General conventions, system rules)   │
└───────────────────┬────────────────────┘
                    ▼
┌────────────────────────────────────────┐
│         Character Scope (2k)           │
│ (Persistent character info, storyline) │
└───────────────────┬────────────────────┘
                    ▼
┌────────────────────────────────────────┐
│            Chat Scope (4k)             │
│  (Temporary notes of current scene)    │
└────────────────────────────────────────┘
Each scope acts as an independent partition, where entries are classified into three lanes with decreasing priority:
•	Open Threads: Contains ongoing events, tasks, or conflicts. This is the only lane that supports a lifecycle closure status (status done). When an entry in this lane is marked as completed, it is removed from the loading list to make room for new information.
•	User Topics: Retains personal data, habits, or topics that the user frequently returns to throughout the interaction process.
•	Character Topics: Represents distinct goals, behavioral motivations, or proactive topics that the character actively wants to bring up in the dialogue.
Marking Mechanism and Bookmark Weight Decay Algorithm
To quickly store important information without disrupting the textual flow of the roleplay, the AI character can proactively create bookmarks via square bracket commands. The core point enabling this system to realistically simulate biological memory is the automatic weight decay algorithm.
The initial weight of each bookmark is set within the range W_start ∈ [0.1, 0.9] (default is 0.5). After each chat turn that does not directly interact with the bookmark's topic, this weight decays according to the mathematical formula:
W_t = W_{t-1} × 0.97
At each subsequent text generation turn, the system performs a stochastic roll by comparing the current weight of the bookmark with a random number generated between 0 and 1. If the weight passes this test, the related memory is pushed into the active context block as a subtle hint, encouraging the character to proactively recall the old topic. When the natural decay process causes the weight to drop below the minimum threshold of 0.1, the system executes an automated cleanup task to free up storage space.
Narrative Arcs Summarization and Clustering Layer
In addition to tracking single events (beats), Marinara Extender builds an advanced processing layer to link events into continuous storyline sequences:
•	Scene Recaps: When the user concludes a scene in Marinara Engine, the system automatically calls the local model to compile the entire development into a prose summary, while retaining the emotional beats with the greatest prominence as footnotes.
•	Through-line Arcs: A background process uses a local embedding model to compute the cosine distance between emotional beats across multiple different scenes, thereby automatically clustering them into a major event chain.
•	Semantic Retrieval: These narrative summaries do not operate based on raw keyword matching but are activated via vector similarity search. This ensures the "story so far" summary appears accurately even when the wording in the current conversation is completely different from the keywords recorded in the past.
Application Programming Interface (REST API) Details
The sidecar server of Marinara Extender exposes a comprehensive REST API system at http://127.0.0.1:3001/api/*. This interface allows both the client extension and third-party applications to manage memory states in detail.
Managing Memory Entries and Bookmarks
GET    /api/entries?scope=&scopeId=&lane=&status=
GET    /api/entries/:id?scope=&scopeId=
POST   /api/entries          { scope, scopeId, lane, summary, content, status? }
PATCH  /api/entries/:id      { scope, scopeId, summary?, content?, status? }
DELETE /api/entries/:id?scope=&scopeId=
GET    /api/bookmarks?scope=&scopeId=
PATCH  /api/bookmarks/:id    { scope, scopeId, weight?, why?, summary? }
DELETE /api/bookmarks/:id?scope=&scopeId=
By default, memory entry query requests automatically filter out completed entities (status done). To view the full memory history, developers can pass the query parameter ?status=all.
Scene, Emotional Beats, and Ingestion Processing
POST   /api/estimate-beats    # Estimate cost and number of fragments before analysis
POST   /api/analyze-beats     # Analyze old conversation into emotional beats (NDJSON stream)
POST   /api/ingest-story      # Analyze free text with automatic speaker allocation
GET    /api/beats?characterId=&full=
DELETE /api/beats/:characterId
POST   /api/beats-to-entries  # Transform stored emotional beats into memory entries
The old beat analysis flow supports streaming data (NDJSON stream), enabling real-time analysis progress updates on the user interface. The free text ingestion feature (/api/ingest-story) allows the system to analyze raw prose paragraphs and automatically allocate dialogue to specific characters.
Speaker Resolution
GET    /api/pending-speakers          # Get list of unidentified speaker labels
POST   /api/resolve-speaker           { label, action, characterId?, characterName? }
GET    /api/aliases                   # Read character alias mapping table
POST   /api/aliases                   # Create new alias link (returns 409 error if conflicted)
DELETE /api/aliases                   # Delete alias link
GET    /api/ignored-speakers          # Get list of ignored speaker labels
POST   /api/restore-speaker           # Restore speaker label from ignore list
POST   /api/orphan-character          # Move all beats of a deleted character back to a pending pool
The speaker resolution system plays a vital role when importing data from external formats. When an unfamiliar name label appears, the system puts it into a pending state and proposes resolution options (mapping to an existing character, creating new, or ignoring) to ensure memory data is not routed to the wrong address.
System State Management and Maintenance
GET    /api/scopes            # List of active partitions containing data with entity counts
GET    /api/health            # Check server status and local model connection
GET    /api/memory-block      # Read completely assembled memory data block (read-only mode)
POST   /api/process-turn      # Client extension post-turn processing endpoint
POST   /api/cleanup           # Periodic maintenance: clean up orphaned entities, merge duplicate entries
POST   /api/backup            # Create a physical backup of the entire YAML database
GET    /api/identity          # Query character identity map
Notably, the /api/backup endpoint creates a physical backup of the entire data directory into an independent timestamped folder at the same level as the installation directory to protect against physical disk corruption.
YAML Storage Structure and Automatic Indexing Mechanism
Unlike memory management systems that use relational databases (SQLite) or complex vector databases, Marinara Extender chooses to store all data as flat YAML files on the hard drive. This design choice brings outstanding advantages in terms of maintainability:
•	High Transparency: Users can easily inspect, edit directly, or back up data using any ordinary text editor.
•	Version Control Capability: YAML files have a clear line-by-line structure, making tracking changes and performing comparison operations (git diff) extremely convenient.
•	Mitigating Database Corruption Risks: Writing data into individual text files minimizes the risk of corrupting the entire database due to sudden power outages or improper shutdowns.
To ensure read/write performance does not degrade as data volume expands, the system builds an automatic indexing mechanism. Each memory partition contains an index.yaml file acting as a hot lookup table. This file stores the mapping between the unique identifier of the memory entry and its physical path, short summary, estimated token size, data lane, memory tier, and operational status.
These indexes are updated fully automatically by the sidecar server whenever a memory initialization or modification occurs. The system recommends that users do not manually edit these index files to avoid causing state desynchronization.
Security and Network Compatibility Analysis
Since the initial design was geared toward running entirely on the user's local machine, the security system of Marinara Extender is built tightly around execution environment isolation and request origin control:
•	CORS Mechanism and CSRF Protection: The sidecar server only binds by default to the loopback address 127.0.0.1. To support user scenarios running Marinara Engine on a different LAN address or domain name, the environment variable MARINARA_EXTENDER_ALLOWED_ORIGIN is used to register additional safe request origins, preventing cross-site request forgery (CSRF) attacks from malicious websites in the browser.
•	Integration of the Marinara Engine Authentication Mechanism: In the latest updates of Marinara Engine, security measures have been tightened to protect user data. By default, connections from the local environment (loopback) are allowed unrestricted access. However, connections from the LAN or internet must pass the Basic Auth barrier and provide an administrative secret code (ADMIN_SECRET) for sensitive tasks such as creating backups or updating the system. Specifically, the system automatically trusts and bypasses authentication for the IP range of the Tailscale network (100.64.0.0/10) and Docker bridge network (172.16.0.0/12) to facilitate the setup of secure home servers.
Deep Contrast With SOTA Memory Solutions (2026)
To clearly understand the position of Marinara Extender, we need to contrast this system with the most modern AI agent memory architecture frameworks today: Mem0 (which just completed a $24 million Series A funding round in 2026), Zep (Graphiti), and Letta (MemGPT).
1. Analysis of SOTA Memory Solutions
•	Mem0 (Hybrid Fact Store): Avoids storing the entire chat history by passing data through an LLM extraction phase to distill it into concise "facts". The unique aspect of Mem0 is its storage behavior classification mechanism (ADD, UPDATE, DELETE, NOOP). If a user changes preferences (e.g., switching from drinking coffee to drinking tea), Mem0 will automatically update or delete the old fact. Memory is organized into 3 scopes: User, Session, and Agent.
•	Zep (Temporal Knowledge Graph): Built on top of the Graphiti engine to radically address the challenge of temporal reasoning. Zep applies a bi-temporal model, clearly storing the time an event occurred in real life (Event time) and the time the system recorded the information (Transaction time). When information changes, Zep does not delete old information but marks a validity window. This allows agents to answer complex questions such as: "How did the user's goals in Q1 differ from now?"
•	Letta (Stateful OS Runtime): Directly implements the research thesis of the famous MemGPT project. Letta treats the LLM context window limit as RAM, and the external database as the Hard Drive. Unlike Mem0 or Zep (which are passive API services receiving commands from applications), Letta creates a stateful agent runtime. The Letta agent itself will call memory modification tools (core_memory_append, core_memory_replace) to proactively decide what information needs to be loaded into RAM (Core Memory) or pushed down to Disk (Archival Memory).
2. Technical Characteristics Comparison Table
Criteria	Marinara Extender	Mem0 (SOTA 2026)	Zep - Graphiti (SOTA)	Letta - MemGPT (SOTA)
Core philosophy	"YAML folder cabinet" local partitioning & Naturally decaying Bookmark notes.	"Fact database" automated extraction and state synchronization.	"Graph timeline" recording history of factual changes.	"Virtual OS" managing context RAM via tool-calling.
Storage model	Flat YAML files written directly to the hard drive.	Vector Database (Qdrant, Pinecone) + Entity Graph.	Postgres + Timeline-based Knowledge Graph.	Relational Database + Vector Index.
Extraction mechanism	Reading square bracket commands from AI (`[remember:]`) + emotional beat analysis model.	LLM model analyzes each message pair, updating ADD/UPDATE/DELETE logic.	Automated extraction of entities, relationships, and timeline anchors.	Driven by the agent itself writing/modifying Core Memory via tool-calling commands.
Conflict resolution	Manual (Curator monitors promotion/demotion, pushes old facts to Retired section).	Automated (LLM model decides to overwrite or eliminate conflicting facts).	Retains everything, marking the expiration timestamp of old facts.	Decided by the agent itself to modify or overwrite data.
Average token volume	Fixed by budget (~7k tokens default).	Extremely low (~1.7k tokens due to compressed fact formatting).	Very large (up to 600k tokens due to loading multiple graph branches).	Highly volatile depending on the agent's load/evict algorithms.
Retrieval Latency	Extremely low (reads directly from local YAML, no network API calls).	Low (~200ms with p95 in SaaS systems).	Medium-High (multi-step graph queries take several hundred ms).	Dependent on the agent's thought loops.

Evaluation of Advantages & Disadvantages of Marinara Extender
Based on the comparison with modern memory technology standards in 2026, Marinara Extender possesses unique strengths but also exposes clear technical bottlenecks that need to be addressed:
1. Outstanding Advantages
•	Absolute Optimization for Local Inference (Local-first & Privacy): The entire operating pipeline does not depend on any cloud connection. The built-in integration of the Dolphin 3.0 model (famous uncensored agentic fine-tuned model line on Ollama) helps the system perfectly process sensitive roleplay content or creative plot generation that censored cloud APIs (like OpenAI, Anthropic) would refuse.
•	Realistic Simulation of Behavioral Psychology: The bookmark weight decay algorithm (W_t = W_{t-1} × 0.97) combined with a stochastic roll is a unique advancement. It perfectly simulates how the biological brain works: memories do not disappear suddenly but fade gradually, occasionally resurfacing in the mind when there is a slight stimulus. This creates a much more natural interactive experience compared to rigid raw vector querying.
•	Transparent and Secure YAML Data Structure: Rejecting packaged databases and choosing YAML as the storage format gives general users full control over their data. Data can be directly edited by hand, backed up manually with a copy command, and never suffers table corruption like SQLite or PostgreSQL.
•	Smart Single Proxy Solution (One-sidecar mode): The /v1/chat/completions endpoint allows maximum sharing of VRAM resources. Instead of running a separate inference server for the Rewrite Assistant extension and a separate one for the Extender, users only need to maintain a single Dolphin instance to shoulder all backend tasks.
2. Disadvantages and Technical Limitations
•	Tag Dependency: This memory system still relies partly on the AI character proactively creating square bracket commands ([bookmark: ...] or [remember: ...]). If the main chat model's temperature is lowered too much or it is not smart enough to comply with the system format, the memory update flow will be immediately disrupted.
•	Belief Contradiction: Unlike Mem0, which can analyze semantics to recognize when a user has moved or changed jobs to delete old info, Marinara Extender loads memory based on static priority and only pushes old information into "cold storage" when the token budget runs out. This easily leads to characters remembering two contradictory realities simultaneously in the loaded context.
•	No Capability for Multi-hop Reasoning: Because it stores data in independent flat YAML files, the system cannot perform complex entity linking. For example, the AI will find it difficult to automatically link data if the user says: "My brother's friend just gave me a gift", because the system lacks a tightly connected entity graph structure to bridge information from "user" -> "brother" -> "brother's friend".
•	Lack of Realistic Time Sense: Although the configuration file contains the MARINARA_EXTENDER_TIMESENSE variable, this feature is disabled in version 1.0. Memory decay is completely based on "turn count" rather than actual time passing in the story. If the plot jumps "3 years later", bookmarks will still maintain their exact weight from the previous turn, breaking the narrative logic.
Proposed Improvement and Optimization Solutions for the Future
To bring Marinara Extender closer to the intelligence level of SOTA systems while preserving its core values of being locally stored, lightweight, and secure, the following technical improvements should be considered for deployment:
1. Transition to Tagless Fact Extraction: The system needs to terminate its reliance on [bookmark:] tags written directly by the AI during a chat turn.
Solution: Establish an asynchronous background worker process. After each turn, this process will send the latest message pair to the local Dolphin model with a specialized system prompt to automatically extract new facts, user habits, or plot twists to monitor. This technique will help enhance the user experience similar to how Mem0 extracts memories automatically without diluting the AI's main text generation flow.
2. Build a Conflict Resolution Gatekeeper: To resolve the belief contradiction issue, the system needs to apply a layer of control logic before writing data to YAML files.
Solution: When the background analysis model detects a new fact (e.g., "User likes drinking Tea"), the sidecar server must perform a quick semantic scan in index.yaml to find semantically similar keys (e.g., "User likes drinking Coffee"). If a conflict is detected, the system will automatically call a handler function to move the file containing the old fact to index.cold.yaml (or mark its status as retired) before recording the new fact into the active data lane.
3. Integrate a Lightweight YAML Entity Index (Local Entity Linking): To achieve multi-hop reasoning capability without installing heavy graph databases like Neo4j or PG Vector, the solution of building a flat entity link map is optimal.
Solution: Build an additional single entity index file named entities.yaml stored under a formatted structure:
character_A:
  relationship:
    character_B: "older_brother"
    character_C: "best_friend"
  topics_of_interest: [ "sister-situation" ]
When the client extension sends a memory query request for a turn containing the name "Character B", the system will not only scan for chat fragments containing the keyword "Character B" but will automatically look up the entity linking file to pull additional memories related to "Character A" (older brother) into the Lorebook context.
4. Activate Dynamic Narrative TimeSense: The MARINARA_EXTENDER_TIMESENSE feature needs to be refactored and activated based on analyzing narrative timeline steps instead of the computer's real-world time.
Solution: Use the local emotional beat analysis model to detect time-indicating phrases in the dialogue (e.g., "The next morning...", "Many months passed..."). When a leap in narrative time is detected, the sidecar will multiply the bookmark weight decay factor accordingly with the elapsed time, forcing old bookmarks to decay faster or disappear entirely to make room for new scene developments, creating an absolutely logical roleplay experience.
By combining these SOTA improvements into the current unique flat YAML file architecture, Marinara Extender can completely become the most powerful and sophisticated local AI agent memory management solution on the market.
References
•	Marinara Engine: r/SillyTavernAI - Reddit, https://www.reddit.com/r/SillyTavernAI/comments/1spufte/marinara_engine/
•	Blog — AI memory, integrations & product updates - Memara, https://app.memara.io/blog
•	Why are people still using SillyTavern when Marinara Engine exists? - Reddit, https://www.reddit.com/r/SillyTavernAI/comments/1td6q7j/why_are_people_still_using_sillytavern_when/
•	Best local LLM for long‑form RP with complex plot and 120–150k context - Reddit, https://www.reddit.com/r/SillyTavernAI/comments/1tbup3w/best_local_llm_for_longform_rp_with_complex_plot/
•	[Feature]: Add a Token-Based Context Limit alongside the existing Message Limit · Issue #289 · Pasta-Devs/Marinara-Engine - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/issues/289
•	README.md
•	AI Agent Memory Frameworks in 2026: Memory vs. Context | Graphlit Blog, https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks
•	Marinara Engine Contributors - GitHub, https://github.com/Pasta-Devs
•	Issues · Pasta-Devs/Marinara-Engine-Refactor - GitHub, https://github.com/Pasta-Devs/Marinara-Engine-Refactor/issues
•	Pasta-Devs/Marinara-Engine: AI frontend - GitHub, https://github.com/Pasta-Devs/Marinara-Engine
•	RPG Companion extension for SillyTavern - Track characters, quests, inventory, and game state with AI-generated content - GitHub, https://github.com/SpicyMarinara/rpg-companion-sillytavern
•	schmich/marinara: Pomodoro® time management assistant for Chrome - GitHub, https://github.com/schmich/marinara
•	Marinara Chrome Extension - Browser Pomodoro Focus Timer - GitHub, https://github.com/Marinara-Chrome-Extension
•	Marinara-Engine/docs/EXTENSIONS.md at main - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/EXTENSIONS.md
•	TTS server: expose available voices for a model via /v1/audio/voices · Issue #742 · Blaizzy/mlx-audio - GitHub, https://github.com/Blaizzy/mlx-audio/issues/742
•	Releases · Pasta-Devs/Marinara-Engine - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/releases
•	Marinara-Engine/docs/CONFIGURATION.md at main - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/CONFIGURATION.md
•	Agent Memory Frameworks Tested: Mem0 vs Zep vs Letta - Particula Tech, https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026
•	AI Agent Memory: 8 Tools That Fix Forgetting | TECHSY, https://techsy.io/en/blog/best-ai-agent-memory-tools
•	AI Agent Memory Systems in 2026: Mem0, Zep, Hindsight, Memvid and Everything In Between — Compared | by Yogesh Yadav | Dev Genius, https://blog.devgenius.io/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8
•	Agent memory solutions: Letta vs Mem0 vs Zep vs Cognee - General, https://forum.letta.com/t/agent-memory-solutions-letta-vs-mem0-vs-zep-vs-cognee/85
•	letta vs mem0: which AI agent memory framework should you run in production?, https://www.cognitionus.com/blog/letta-vs-mem0
•	State of AI Agent Memory 2026: Benchmarks, Architectures & Production Gaps - Mem0, https://mem0.ai/blog/state-of-ai-agent-memory-2026
•	AI Agent Memory: Build Your Own or Buy Off the Shelf? | Chanl Blog, https://www.channel.tel/blog/voice-ai-memory-build-vs-buy-comparison
•	The Future of AI Agents: How External Memory, Mem0, and MemGPT Are Transforming Long-Term Context Management | by HARI KRISHNA BEKKAM | Medium, https://medium.com/@harikrishnabekkam1590852/the-future-of-ai-agents-how-external-memory-mem0-and-memgpt-are-transforming-long-term-context-23f4ec88f66d
•	dolphin3:8b - Ollama, https://ollama.com/library/dolphin3:8b
•	Marinara's LLM Hub, https://spicymarinara.github.io/
•	The 6 Best AI Agent Memory Frameworks You Should Try in 2026, https://machinelearningmastery.com/the-6-best-ai-agent-memory-frameworks-you-should-try-in-2026/
