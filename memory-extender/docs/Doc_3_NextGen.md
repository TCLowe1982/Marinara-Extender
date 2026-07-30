Next-Generation Persistent Memory Architecture: Comprehensive Upgrade of Marinara Extender for Ultra-Long Chronicles Writing and Multi-Year Conversational Memory Retrieval

Architectural Evolution Process and Current Limitations of Marinara Extender 

The evolution of artificial intelligence interaction interfaces from simple chatbots to agent-oriented platforms demands a revolutionary transformation in state management and long-term memory execution. Among modern solutions, Marinara Engine emerges as a powerful tool inherited from SillyTavern, driven by its parallel multi-agent architecture and its capacity for deep intervention within the text processing pipeline. The Marinara Extender extension, developed as a successor to the SillyTavern ecosystem and the RPG Companion designed by SpicyMarinara, operates at the post-generation stage specifically to manage and maintain character states. 

The current architecture of Marinara Extender operates on an independent Sidecar model, comprising a local Node.js server running on port 3001 and a thin extension loader script embedded within the client browser. This model guarantees the isolation of heavy computational logic and data storage components from the UI rendering thread, thereby optimizing latency indices and preventing memory leak failures. Storage operations utilize flat YAML files, providing high data transparency, easy version control via standard line-comparison utilities, and minimizing the risk of physical database corruption. 

Despite these unique strengths, the current framework exhibits severe technical bottlenecks when facing complex, real-world narrative scenarios. Context management based on static pruning queues or fixed token budget allocations—defaulting to Chat (4k), Character (2k), and Global (1k)—easily triggers context window overflow or causes a total loss of long-term character consistency once the narrative scope outgrows the loading boundaries of the Lorebook. This "context overflow error" phenomenon occurs frequently on local consumer hardware, where large language models silently truncate trailing information upon exceeding physical boundaries, causing a severe degradation in the agent's reasoning and retention capacities. 

Furthermore, the biological bookmark weight decay algorithm, which operates on a fixed coefficient formula: 

$$W(t) = W(t - 1) \times 0.97$$

combined with a randomized test merely based on the count of physical conversation turns, lacks any realistic awareness of the narrative timeline or the actual history of changes. Over-reliance on structural indicators like [bookmark:] or [remember:] generated natively by the language model within chat turns makes the system prone to disruptions if the inference temperature drops too low or if the model lacks the structural intelligence to adhere to the formatting constraints. To elevate Marinara Extender into an outstanding persistent memory layer capable of handling long-form creative chronicles requiring absolute logic and archiving memories across thousands of multi-year conversational messages, the system must undergo a comprehensive restructuring into a hybrid storage paradigm. 

Absolute Logical Consistency Architecture for Ultra-Long Chronicles 

Composing long-form literary works with complex narrative designs, such as detective fiction, forensic investigations, or historical epics, requires a rigid logical control system. Within these genres, even a minor logical discrepancy will completely shatter the structural integrity and consistency of the work. Upgrading Marinara Extender requires shifting from a simple semantic similarity retrieval mechanism to a multi-layered logical control architecture. 

Plot Blueprint Based on Directed Acyclic Graphs 

The definitive solution for maintaining long-term narrative logic is constructing a Directed Acyclic Graph (DAG) that acts as the single source of truth for event progression. Within this graph model, nodes represent specific structural events containing metadata about participating characters, locations, timelines, and item states, while edges define absolute causal relationships between events. Edge connection rules dictate that a narrative event can trigger if and only if all its prerequisite predicate event nodes have been successfully cleared. 

A network of specialized AI agents will continuously execute read and write operations against this central graph blueprint through clearly demarcated roles: 

The Architect: Responsible for outlining the initial plot framework and establishing major event milestones based on the author's structural requirements. 

The World Builder: Enriches event nodes by injecting detailed profiles regarding location attributes, character information, and the physical or legal constraints of the historical setting. 

The Drama Coach: Analyzes the structural graph to detect tedious or undramatic segments, thereby proposing the insertion of conflict nodes or unexpected plot twists. 

The Dependency Manager: Functions as a strict logical consistency validator. This agent runs topological sorting algorithms and continuously processes prerequisite verification queries to ensure that no temporal paradoxes or contextual logic errors occur. 

The Narrator: Once the graph is fully validated and cleared of any logical defects, the narrator traverses the event nodes in topological order and converts structural descriptions into artistic prose, providing the language model with only the minimum context payload required for that specific scene. 

To guarantee the semantic validity of the generated graph models, the system employs a Projectional Decoding technique. This technique maintains a partial model graph as the primary representation throughout the large language model's generation run, enabling incremental semantic validity checks and guiding the language model to generate outputs with high logical consistency aligned with real-world constraints. 

Integrated Bi-Temporal Sense of Time 

One of the greatest drawbacks of current memory systems is the lack of awareness regarding the actual passage of time within the story. When the plot skips timelines, systems based on conversation turns still retain the original weights of old memories. To overcome this, the system integrates a Bi-temporal Model inspired by the Graphiti architecture. 

Each relationship or fact stored within memory is tagged with two independent time axes: 

Valid Time ($T_v$): The time interval during which that fact is considered true within the story's world. 

System Time ($T_s$): The timestamp when the system records this information into the memory database. 

This model is mathematically described through a set of bitemporal entities $\mathcal{M}$. When executing a memory query at a specific plot time milestone $t_v$ and system time milestone $t_s$, the state filtering function extracts the exact snapshot of the world at that moment: 

$$asof(\mathcal{M}, t_v, t_s) = \{f \in \mathcal{M} \mid t_v \in [t_{\text{from}}^v, t_{\text{to}}^v) \wedge t_s \in [t_{\text{from}}^s, t_{\text{to}}^s)\}$$

When the author writes a text input indicating a significant chronological shift, the emotional pacing analysis agent detects these dynamic timeline phrases. The system automatically adjusts the world's current plot time milestone $t_v$, thereby auto-invalidating expired relationships and accelerating the decay of short-term bookmarks associated with the old scene, ensuring the absolute logic of the historical context. 

Resolving Cognitive Conflict with TOKI Operator Algebra 

During long-term plot development, the emergence of contradictory information or changes in entity states is inevitable. If the system simultaneously feeds both pieces of conflicting information into the context, the language model will fall into a state of cognitive conflict and generate illogical responses. The system thoroughly resolves this problem by integrating the TOKI operator algebra framework. 

Two memory entities $f_1$ and $f_2$ are considered contradictory (denoted as $f_1 \mathbin{\#} f_2$) when they simultaneously satisfy the following conditions: 

$$f_1 \mathbin{\#} f_2 \iff (s_1 = s_2) \wedge (p_1 = p_2) \wedge (o_1 \neq o_2) \wedge ([t_{\text{from}}^{v1}, t_{\text{to}}^{v1}) \cap [t_{\text{from}}^{v2}, t_{\text{to}}^{v2}) \neq \emptyset)$$

That is, they share the same subject ($s$) and predicate/property ($p$), but differ in their object value ($o$), while their valid time intervals overlap. When a contradiction is detected on the data write pipeline, TOKI routes the information through an isolation gate and applies one of four bitemporal operators to resolve it: 

Last-Writer-Wins (LWW) Operator: Typically used for simple physical state changes, updating to the newest value based on the system recording timestamp. 

Evidence-Weighted Merge Operator: Used when information sources have varying degrees of reliability, recalculating memory strength based on source credibility indices. 

Await-Confirmation Operator: Places conflicting information into a separate moderation queue and requests a decision from the author or the Dependency Manager agent. 

Per-Rule Policy Operator: Applies rigid logical rules inherent to the setting. 

A unique feature of the TOKI architecture is the deployment of the "Audit-Row Defense" mechanism. When an old fact is replaced by a new one, the system does not delete the old data from the YAML file. The superseded fact is moved to a dedicated Audit Row with a superseded status. This mechanism preserves the full history of the character's cognitive shifts, allowing a detective character in the story to query historical data consistently. 

ROXY Predictive Question Indexing Mechanism 

To optimize information retrieval from the massive memory repository of an ultra-long work, the system integrates the ROXY (Retrieval-Oriented Memory Framework). For each memory segment or plot node, the language model automatically runs a Generative Indexing process. This process generates hypothetical questions or suggestive keywords that the author might ask in the future to reference this memory, then indexes those questions in parallel with the original content. 

When the author writes a new turn, the system performs a similarity search on this predictive question index, thoroughly resolving "Retrieval Mismatch" errors that occur when the current prompt lacks semantically matching keywords with the archived document. Subsequently, a Conflict-Aware Reranker resorts the results based on logical consistency metrics before feeding them into the Lorebook. 

Managing and Mining Memories from Thousands of Multi-Year Conversational Messages 

For the objective of processing memories from conversations containing thousands of messages accumulated over multiple years across one or more individuals, traditional flat YAML file storage encounters severe I/O bottlenecks due to continuous disk read/write operations. Concurrently, information in real-world chat histories is often fragmented, noisy, and lacks speaker identity consistency. 

Speaker Diarization and Multi-Agent Dialogue Processing Workflow 

When ingesting large-scale historical conversation data, accurately identifying the speaker is a prerequisite to building a memory base free of semantic pollution. The system implements a deep learning-integrated Speaker Diarization solution to solve the "who spoke what and when" problem in historical audio files or dialogue transcripts. 

The audio dialogue processing workflow goes through four core steps: 

Audio Segmentation: Breaks down the audio stream into short speech segments ranging from 0.5 to 10 seconds based on physical silences. 

Speaker Embedding Generation: Converts speech segments into high-dimensional real-valued vectors representing the unique biological characteristics of the voice. 

Speaker Count Estimation: Determines the actual number of participating entities within the data file. 

Clustering and Assignment: Applies clustering algorithms to group speech segments with similar vectors together and assigns anonymous labels such as speaker_0, speaker_1. 

To overcome traditional diarization errors caused by overlapping speech (crosstalk) or environmental noise, the system utilizes an LLM-Adaptive Diarization architecture. This method employs a large language model as a post-processing correction engine. The model is fine-tuned on dialogue pairs to analyze semantic cues, discourse structures, and pragmatics in text to automatically detect and correct mislabeling from traditional audio diarization tools, reducing the Word Diarization Error Rate (WDER) by up to 55.5%. 

Once labeled, the text data is transmitted to Marinara Extender's /api/ingest-story endpoint to automatically analyze and allocate dialogue to specific characters based on the character alias mapping table (aliases.yaml). When an unfamiliar name label appears, the system routes it to a pending state via /api/pending-speakers and suggests resolution options (map to an existing character, create new, or ignore) to ensure memory data is not misrouted. 

Hierarchical Memory Model and the FadeMem Decay Mechanism 

To persistently retain critical information across multiple years without diluting context with trivial details, the system applies a three-tiered memory architecture (Working - Short-Term - Long-Term Memory) combined with the FadeMem model orchestration algorithm. All memory entities in the system are represented as a structured dataset including: raw content, semantic embedding vectors, initial memory strength $v(0) \in [0, 1]$, recorded timestamp $\tau$, and access frequency. 

The memory strength decay process is calculated using an adaptive exponential function: 

$$v(t) = v(0) \cdot e^{-\lambda(t-\tau)^\beta}$$

Where the decay coefficient $\lambda$ changes dynamically based on the importance score assigned to the memory at extraction time. The parameter $\beta$ modulates the elasticity of time. 

To prevent continuous memory oscillation between storage tiers, the system utilizes a hysteresis mechanism with two distinct thresholds: a promotion threshold $\theta_{\text{promote}}$ and a demotion threshold $\theta_{\text{demote}}$. A memory entity in the Short-Term Memory Layer (SML) is only promoted to the Long-Term Memory Layer (LML) when its strength exceeds $\theta_{\text{promote}}$, but it is only demoted back to the SML or removed entirely when it decays below $\theta_{\text{demote}}$. When a memory is re-accessed via vector similarity search, the system executes memory consolidation, resetting memory strength to its peak value to emulate information recall in biological brains. 

YMYL Classification to Safeguard Crucial Information 

For conversations containing substantial sensitive personal information, the system integrates a two-stage YMYL (Your Money Your Life) classifier. Stage one leverages high-speed regular expressions (Regex) to rapidly detect sensitive keywords related to health, finance, or legal matters. Stage two utilizes a local language model to analyze deep semantic implications. 

When a memory is categorized under the YMYL group, it receives special protection: a higher importance floor, exemption from the FadeMem temporal decay process, and mandatory validation via the TOKI contradiction resolution pipeline prior to storage to prevent archiving skewed health or financial records. 

Infrastructure Optimization Solutions and Read/Write Mechanisms 

To ensure stable operation on local hardware without incurring resource bottlenecks, Marinara Extender's infrastructure layout requires a comprehensive redesign. 

RAM Cache Architecture and Deferred Asynchronous Write Queue 

To thoroughly resolve hard disk bottlenecks caused by handling thousands of small YAML files, Marinara Extender implements an In-Memory YAML Cache tier tied to an Asynchronous Write Queue. Upon sidecar server initialization, the entire indexing layout from index.yaml is loaded into the Node.js process RAM as optimized Map data structures. Every read request from Marinara Engine is served directly from this RAM space with near-zero latency. 

Every write or update request is pushed into a task queue governed by a debounce mechanism to throttle disk write frequency. Every 30-second cycle, the system aggregates write requests from the queue, synchronizes the RAM data, and executes a single flush to the hard disk, preserving YAML file transparency while guaranteeing optimal performance. 

Plaintext

┌────────────────────────────────────────────────────────┐

│             Memory Write/Update Request                │

└───────────────────────────┬────────────────────────────┘

                            ▼

┌────────────────────────────────────────────────────────┐

│         Instant Update to RAM Cache Buffer             │

│  - Immediately serves subsequent read requests         │

└───────────────────────────┬────────────────────────────┘

                            ▼

┌────────────────────────────────────────────────────────┐

│       Enqueued into Deferred Queue (Debounce)          │

│  - Batches continuous write requests                   │

└───────────────────────────┬────────────────────────────┘

                            ▼

┌────────────────────────────────────────────────────────┐

│       30s Cycle: Synchronous Single Write to Disk      │

│  - Updates index.yaml and partitioned files            │

└────────────────────────────────────────────────────────┘

(Data pipeline mapping index architecture synchronization lifecycle) 

Context Allocation Mechanism Based on the Knapsack Algorithm and Middle-Out Pruning 

When incorporating memory into the context window of large language models, the system applies a dynamic allocation mechanism based on the knapsack problem algorithm. Rather than employing a fixed message count, the system measures the actual token footprint of each context block based on the specific tokenizer of the active model. The context budget is dynamically allocated according to a strict priority hierarchy: 

Priority

Context Component

Management Method

Priority 1

System Prompt and Character Card

Kept static to preserve character identity. 

Priority 2

Most Recent Turns (2-3 messages)

Retained as-is to maintain direct conversation flow. 

Priority 3

Retrieved Long-Term Memories

Dynamically loaded based on similarity and strength scores. 

Priority 4

Old Conversation History

Utilizes the remaining context budget. 

When the total payload exceeds the context window boundary, the system executes a "middle-out pruning" technique. Instead of dropping lines from the beginning or the end, the system purges messages from the middle of the chat log—the segment typically hosting the least crucial details—to retain systemic boundaries at the top and the freshest interactions at the tail. Concurrently, the system maintains a 10% safety buffer below the model's physical context ceiling to completely avert context overflows that cause sudden memory losses. 

Technical Comparison and Optimal Configuration Profiles 

To adjust the system layout for peak local machine performance, Marinara Extender configuration metrics must be precisely fine-tuned. 

Cross-Comparison Matrix of Modern AI Memory Implementations 

Below is a granular comparison chart pitting the comprehensively upgraded Marinara Extender framework against the world's leading memory layers: 

Technical Specification

Marinara Extender (Upgraded)

Mem0 (SOTA 2026)

Zep - Graphiti (SOTA)

Letta / MemGPT

Storage Model

RAM Cache Buffer + Flat DAG Graph storing YAML. 

Vector DB + Parallel Entity Graph. 

Postgres + Timeline Knowledge Graph. 

Relational DB + Vector Indexing. 

Extraction Mechanism

Background Unlabeled Extraction + TOKI Operators. 

LLM automatically analyzes message pairs (ADD/UPDATE). 

Automated entity extraction and timeline linking. 

Agent autonomously invokes memory-editing tools. 

Conflict Resolution

TOKI Algebra + Audit-Row Defense. 

LLM automatically decides to override or discard old facts. 

Marks expiration milestones of facts, preserving history. 

Agent self-determines data updates or overwrites. 

Temporal Awareness

Strictly integrated bi-temporal model ($T_v$ and $T_s$). 

No intrinsic temporal layout, filtered by creation date. 

Bi-temporal model with valid_from and valid_to. 

No intrinsic temporal structure. 

Retrieval Latency

Ultra-low (served directly from Node.js RAM Cache). 

Low (~200ms via SaaS infrastructure). 

Medium (~300ms due to multi-step graph queries). 

Dependent on agent reasoning loop cycles. 

Recommended Environment Configuration Profiles for the Upgraded Framework 

System engineers must set these environment variables within the sidecar host's .env repository to unlock full tuning assets: 

Environment Variable

Config Value

Detailed System Blueprint Impact

MARINARA_EXTENDER_PORT

3001

Local network gateway port for sidecar server API processing. 

MARINARA_EXTENDER_DATA

data/storage

Physical file trajectory hosting YAML data arrays and entity indexes. 

MARINARA_EXTENDER_LOCAL_MODEL

dolphin3:8b

Local language model powering silent processing runs and fact extraction routines. 

MARINARA_EXTENDER_TIMESENSE

2

Set to 2 to fully activate bi-temporal temporal mapping capabilities. 

MARINARA_EXTENDER_USE_DAG

1

Deploys the structural constraint checking framework for the Story Blueprint DAG. 

MARINARA_EXTENDER_DEBOUNCE

30000

Disk write debounce delay (30 seconds) maximizing storage asset I/O performance. 

MARINARA_EXTENDER_FADEMEM_PROMOTE

0.75

Strength threshold metric promoting a record from SML to LML status. 

MARINARA_EXTENDER_FADEMEM_DEMOTE

0.30

Strength threshold metric demoting or freezing an obsolete record to cold cache arrays. 

BYPASS_AUTH_TAILSCALE

true

Allows programmatic authentication bypass targeting validated Tailscale grid arrays. 

BYPASS_AUTH_DOCKER

true

Allows programmatic authentication bypass across the local Docker bridge layout. 

Integration Roadmap and Recommended Actionable Tasks 

To turn these theoretical paradigms into a durable codebase for Marinara Extender, the engineering roadmap prescribes four rigid technical implementation intervals: 

Step 1: Transitioning to Background Implicit Extraction 

Engineers must fully dismantle structural reliances on text markers like [bookmark:] or [remember:] produced inside user chat outputs. A dedicated asynchronous background worker process must be initialized on the sidecar backend server framework. The moment chat transaction data arrives from the front end via the /api/process-turn gateway, the background routine transfers the textual data to the local Dolphin engine utilizing a tailored parsing prompt to autonomously parse emerging facts, behavioral indicators, or key narrative milestones requiring active observation. This mechanism refines the overall user experience, ensuring that information harvesting persists continuously without polluting the primary language generation pipeline. 

Step 2: Architecture of the In-Memory RAM Cache and Hybrid Storage System 

Program a local In-Memory Hybrid Cache storage layout directly within the sidecar runtime Node.js source logic. During backend startup runs, the holistic map schema from index.yaml is deployed into RAM buffers structured as high-performance JavaScript Map records. Semantic similarity profiling tasks evaluate cosine distance metrics via an optimized linear vector mathematics module operating directly inside active memory arrays, fully cutting out programmatic dependencies on high-cost cloud vector database instances. Local disk writing processes run throttled via a debounce writing queue using a 30-second synchronization index to secure hardware lifespan metrics while maintaining local environment speeds at their maximum boundaries. 

Step 3: Deployment of Flat Entity Indexing Layouts and Graph Boundary Rule Controls 

Engineers must structure a unified entity registry profile designated as entities.yaml to successfully resolve multi-hop relational vectors. Upon reference to a character token or major event milestone, the system bypasses coarse keyword matching routines to actively traverse the entity graph map, pulling the total set of relational storage entries into the live Lorebook layout. Concurrently, targeting high-volume epic literature production scopes, developers must introduce a lightweight mathematical Constraint Logic Solver library into the system loop. Whenever updates scale the narrative DAG structure, this auditing thread scans alternate pathways to confirm that no historical paradoxes, location discrepancies, or character attribute anomalies persist before clearing the script for text generation routines. 

Step 4: Integration of TOKI Operator Algebra and Audit-Row Safeguards 

Upgrade the contradiction resolution logic within the Marinara Extender repository by implementing the mathematical formulas of the TOKI operator layout. The system must be explicitly programmed to recognize cognitive discrepancies utilizing a core subject-predicate indexing key. Upon finding a logic clash, instead of executing blind data overwrites that erase older tracks and provoke audit failures, the routine generates a brand-new fact object containing updated validity boundaries while re-routing the legacy record down to an auxiliary data array labeled audit_history embedded right inside that entity's YAML schema. This specific coupling endows the underlying language model with the rare ability to query an unbroken lineage of cognitive updates, elevating the literary output to a level of profound depth and unassailable consistency in the art of behavioral tracking and character psychology development. 

Sources / Bibliography 

Phân Tích Marinara Extender Và Tài Liệu Bổ Sung (1).docx 

Báo Cáo bổ sung Phân Tích Toàn Diện Marinara Extender.docx 

$$Feature$$

: Add a Token-Based Context Limit alongside the existing Message Limit · Issue #289 · Pasta-Devs/Marinara-Engine - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/issues/289 

AI-Driven Storytelling with Multi-Agent LLMs - Part III - The Computist Journal, https://blog.apiad.net/p/ai-driven-storytelling-with-multi-3ed 

Accurate and Consistent Graph Model Generation from Text with Large Language Models, https://www.researchgate.net/publication/397931572_Accurate_and_Consistent_Graph_Model_Generation_from_Text_with_Large_Language_Models 

Releases · Pasta-Devs/Marinara-Engine - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/releases 

Graphiti — Zep, https://www.getzep.com/platform/graphiti/ 

Graphiti: Knowledge graph memory for an agentic world - Neo4j, https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/ 

Knowledge Graphs as Memory: Why Your AI Agent Needs to Think in Relationships, https://www.octoco.ai/blog/knowledge-graphs-as-memory 

mnemo_graph - Rust - Docs.rs, https://docs.rs/mnemo-graph 

TOKI: A Bitemporal Operator Algebra for Contradiction Resolution in LLM-Agent Persistent Memory - arXiv, https://arxiv.org/html/2606.06240v1 

ROXY: Generative Indexing and Conflict-Aware Reranking for Long-Horizon Conversational Memory | OpenReview, https://openreview.net/forum?id=edxkMD5v3I 

TOKI: A Bitemporal Operator Algebra for Contradiction Resolution in LLM-Agent Persistent Memory - ResearchGate, https://www.researchgate.net/publication/406039523_TOKI_A_Bitemporal_Operator_Algebra_for_Contradiction_Resolution_in_LLM-Agent_Persistent_Memory 

TOKI: A Bitemporal Operator Algebra for Contradiction Resolution in LLM-Agent Persistent Memory - arXiv, https://arxiv.org/pdf/2606.06240 

$$2606.06240$$

TOKI: A Bitemporal Operator Algebra for Contradiction Resolution in LLM-Agent Persistent Memory - arXiv, https://arxiv.org/abs/2606.06240 

Why agent memory solutions based on KGs, Markdown files and dream pipelines used by harnesses ATM simply don't feel right to me · GitHub, https://gist.github.com/Jakedismo/94d9d37f6de7787bdac2a96500a28ba3 

What is speaker diarization and how does it work? (Complete 2026 Guide) - AssemblyAI, https://www.assemblyai.com/blog/what-is-speaker-diarization-and-how-does-it-work 

What is speaker diarization? - Gladia, https://www.gladia.io/blog/what-is-diarization 

Implementing Speech-to-Text with Speaker Diarization: Comparing Pyannote and Sortformer on VAST.ai, https://vast.ai/article/whisper-pyannote-sortformer-diarization-vast 

How to Add Speaker Diarization to Your AI Transcription Workflow - MindStudio, https://www.mindstudio.ai/blog/speaker-diarization-ai-transcription-workflow 

LLM-Adaptive Diarization - Emergent Mind, https://www.emergentmind.com/topics/llm-adaptive-diarization 

FadeMem: Why Teaching AI Agents to Forget Makes Them Remember Better - CORe Inc., https://co-r-e.com/method/agent-memory-forgetting 

How to Build AI Agents That Actually Remember: Memory Architecture for Production LLM Apps - DEV Community, https://dev.to/pockit_tools/how-to-build-ai-agents-that-actually-remember-memory-architecture-for-production-llm-apps-11fk 

Reduce Token Cost for LLMs: AI Agent Memory with Valkey and Mem0, https://valkey.io/blog/ai-agent-memory-with-valkey-and-mem0/ 

GitHub - remete618/widemem-ai: Next-gen AI memory layer with importance scoring, temporal decay, hierarchical memory, and YMYL prioritization, https://github.com/remete618/widemem-ai 

Queues | NestJS - A progressive Node.js framework, https://docs.nestjs.com/techniques/queues 

JavaScript Debounce Function - David Walsh Blog, https://davidwalsh.name/javascript-debounce-function 

CodeTips#10: Throttle and Debounce Because your code could use a little discipline - The Miners, https://blog.codeminer42.com/codetips10-throttle-and-debounce/ 

Mem0 vs Zep (Graphiti): AI Agent Memory Compared (2026) - Vectorize, https://vectorize.io/articles/mem0-vs-zep 

Mem0 - AI Memory Layer for your Agents & Apps | Persistent Context, https://mem0.ai/ 

AI Memory Architecture: How to Build One That Actually Works - TiDB, https://www.pingcap.com/blog/how-to-build-an-ai-memory-architecture-that-actually-remembers/ 

State of AI Agent Memory 2026: Benchmarks, Architectures & Production Gaps - Mem0, https://mem0.ai/blog/state-of-ai-agent-memory-2026 

GAM: Hierarchical Graph-based Agentic Memory for LLM Agents - arXiv, https://arxiv.org/html/2604.12285v1 

Marinara-Engine/docs/CONFIGURATION.md at main - GitHub, https://github.com/Pasta-Devs/Marinara-Engine/blob/main/docs/CONFIGURATION.md 

Pasta-Devs/Marinara-Engine: AI frontend - GitHub, https://github.com/Pasta-Devs/Marinara-Engine 



