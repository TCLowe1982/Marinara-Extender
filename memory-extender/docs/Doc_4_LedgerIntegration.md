Research on Super Memory Solutions Based on Marinara Extender and Proposed Integration Plan for the Immutable Ledger Pattern 

The evolution of artificial intelligence interactive interfaces from simple chatbot models to agent-oriented platforms demands revolutionary advancements in state management and long-term memory. Among modern open-source platforms, Marinara Engine emerges as a powerful tool inherited from SillyTavern, thanks to its parallel multi-agent architecture and its capability to intervene deeply in the text processing pipeline. To sustainably maintain character states without memory leaks or consuming primary system resources, the Marinara Extender project was developed as an external memory system operating at the post-generation stage. However, when the interaction context extends to millions of tokens over multiple years, traditional context management techniques reveal drawbacks that degrade the character's long-term consistency. Integrating the "ledger-pattern.md" document (immutable ledger pattern) into Marinara Extender delivers an optimal architectural solution, thoroughly resolving cognitive dissonance errors, controlling data bloat, and ensuring absolute safety during backup operations. 

Historical Background and Sidecar Architecture of Marinara Extender 

The Marinara Engine ecosystem is developed by the Pasta-Devs group, an organization focused on local inference optimization and agent architecture using TypeScript, currently migrating its structure to Tauri to optimize cross-platform support. Prior to the creation of this engine, the RPG Companion extension for SillyTavern, designed by SpicyMarinara, introduced capabilities for character attribute tracking, scene information boxes, and the AI's private thoughts. During the development of Marinara Engine, the features of RPG Companion were integrated directly into the system core via three processing pipelines: pre-generation, concurrent, and post-generation. 

In this context, Marinara Extender operates independently as a Sidecar server model using Node.js running on port 3001, linked to a thin utility file embedded directly in the user's browser. This mechanism completely isolates heavy text processing logic from the UI rendering thread, optimizing latency and preventing memory overflow errors in the client browser. Diverging from systems that use complex relational databases or expensive vector databases, Marinara Extender opts to store all data as flat YAML files on the hard drive. This design yields high transparency, allowing users to control their personal data, easily compare modified versions using source control tools, and mitigate physical database corruption errors during abrupt system shutdowns. 

To accelerate lookups without degrading read/write performance as the accumulated data scale swells, the system implements an automated indexing mechanism. Each memory partition contains an index.yaml file that acts as a hot lookup table, storing mappings between the memory item's unique identifier and its physical path, short summary, estimated token capacity, data lane, memory level, and active state. 

The Super Memory Paradox and Attention Triage Failure 

When the conversation context exceeds the loading limit of the Lorebook, the traditional Marinara Extender system faces context window congestion. Maintaining static token budget allocations—defaulting to Chat (4,000 tokens), Character (2,000 tokens), and Global (1,000 tokens)—causes the large language model to silently drop information once the physical limits of the context window are breached, severely degrading long-term reasoning capabilities. More specifically, empirical research indicates that information loss arises not only from physical token constraints but also from a cognitive psychology phenomenon in language models known as "Attention Triage". 

When a prompt containing an excessively large volume of text is fed into the model, the LLM automatically executes a selection mechanism: it only focuses its response on the most prominent information (salient results) while silently ignoring smaller details, mis-attributing attributes, or truncating phrasing. A concrete real-world case has been recorded: information regarding the character Mari having a D&D class of "Pact of the Tome Warlock" was completely forgotten by the model when processed within a wide extraction window consisting of 10 text segments, yet it was accurately retrieved by the exact same model when placed within a focused, compact context window. This proves that stuffing context into a massive prompt does not solve the super memory problem, as this is a limitation of the model's attentional capacity rather than merely memory capacity. 

Bitemporal Multi-Tier Memory Architecture and Adaptive Speaker Diarization 

To sustainably store critical information across multiple years without diluting the context with trivial details, the Marinara Extender's super memory system applies the orchestration model of the FadeMem algorithm. This mechanism simulates the Ebbinghaus forgetting curve by layering memory into three tiers: Working Memory, the Short-Term Memory Layer (SML), and the Long-Term Memory Layer (LML). The decay process of memory strength is calculated using an adaptive exponential function based on importance and access frequency. 

The decay coefficient $\lambda$ changes dynamically according to the initial importance of the memory, while the shape parameter $\beta$ is orchestrated differently between tiers to yield compatible decay rates ($\beta = 0.8$ for the LML to produce slow sub-linear decay; $\beta = 1.2$ for the SML to produce rapid super-linear decay). At the baseline, memories in the LML partition have a half-life of approximately 11.25 days, whereas SML memories decay faster with a half-life of 5.02 days. The system utilizes a hysteresis effect with two distinct thresholds—a promotion threshold $\theta_{\text{promote}} = 0.75$ and a demotion threshold $\theta_{\text{demote}} = 0.30$—to prevent constant oscillation between tiers. 

When users discuss sensitive personal topics, a two-stage YMYL (Your Money Your Life) classifier—employing regular expressions combined with deep semantic analysis—automatically flags and assigns the highest importance floor to health or financial memories, exempting them from the FadeMem decay process. 

For restoring and mining memory from thousands of multi-year historical conversations, accurately identifying speaker identity is a prerequisite to avoid data contamination. The system deploys a speaker diarization solution integrated with deep learning models to solve the problem of "who spoke what and when". Through four core steps—physical audio segmentation, voice embedding generation, speaker count estimation, and clustering-based labeling—the system transforms audio streams into structured text. To overcome overlapping speech or environmental noise, the LLM-Adaptive Diarization architecture uses a large language model as a post-processing corrector, analyzing pragmatics structures and discourse semantics to rectify mislabeling errors from the traditional audio diarizer, thereby reducing the Word Diarization Error Rate (WDER) by up to 55.5%. Once diarized, the text is sent to the Extender's /api/ingest-story endpoint to automatically analyze and assign conversations to specific characters based on the character alias mapping table aliases.yaml. 

Proposed Integration Plan for the Immutable Ledger Pattern into Extender 

To optimize conflict prevention, manage data bloat, and enhance backup security, the integration proposal for the Immutable Ledger Pattern into Marinara Extender is built upon four foundational stages: Ledger setup, Window splitting, Asynchronous processing, and Consensus assembly. 

1. Intermediate Ledger Setup 

The system constructs a persistent temporary ledger file on the hard drive to record the information extraction progress. The ledger acts as a storage layer mapping text chunks to their corresponding analysis results. This mechanism provides instantaneous data recovery capabilities following a physical disk power failure, allowing the system to resume processing from the nearest chunk without re-running the entire document from scratch, while also enabling developers to easily audit the extraction quality of each chunk prior to final aggregation. 

2. Sliding Window Splitting and Context Allocation Rules 

The system fragments large conversation histories or input text based on the actual loading capacity of the active model rather than relying on static constants. To preserve prompt integrity and prevent the LLM's attention triage, the context space is strictly partitioned according to the one-third ($1/3$) rule: 

Context Partition Component

Allocation Ratio

Detailed System Significance

System Prompt and Instructions

~1/6 physical context

Contains the system prompt, output format schema, and illustrative examples. 

Input Chunk

~1/6 physical context

The segment of conversation history extracted for processing in the current turn. 

Remainder

~2/3 physical context

Serves as the output generation space (output reserve) for writing tasks, or a recall-slack space that helps the model maximize focus on memory extraction tasks. 

To ensure facts lying on the cutting boundaries are not mechanically discarded, the system applies a sliding window shift mechanism with a 10% to 20% overlap between adjacent chunks. This overlap functions as a data retrieval insurance policy at the boundary joints. 

3. Asynchronous Processing Workflow 

Because performing multi-pass runs across dozens of chunks consumes substantial inference time, synchronous execution would freeze the user interface. Extender shifts the entire workflow to an asynchronous background job queue model. When a user requests ingestion of extensive historical data, the system immediately returns a receipt containing a job ID, allowing the user to continue the current conversation while the sidecar server silently processes chunks in the background queue and continuously updates progress. 

4. Consensus Assembly and Overlap De-duplication Mechanism 

The fatal flaw of traditional memory systems lies in using a naive union to merge results from different chunks, which retains duplicate information phrased differently, overloads downstream filters, and preserves mislabeling errors from single scans. Extender implements a strict consensus assembly workflow divided into two primary steps: 

Span-overlap dedup runs first: Due to the 10-20% overlap between windows, a fact may appear twice within a single scanning run. The system must normalize semantics and merge these duplicate records into one before performing the consensus calculation step. Otherwise, a fact appearing at the boundary of a single scan would be counted as two consensus votes, distorting the filtering outcome. 

Consensus in normalized space: The system normalizes memory sentences into a canonical identity through a vector similarity analysis step or a condensed LLM pass. A memory is officially recorded into long-term storage only when it achieves a majority consensus across independent scans: 

$$\text{consensus\_count} \ge \left\lfloor \frac{N}{2} \right\rfloor + 1$$

With this mechanism, increasing the number of analytical passes (multi-pass) enhances the accuracy of the super memory system, completely eliminating random misattribution errors. 

Database Schema Design for the TOKI Immutable Ledger 

To systematically execute the immutable ledger model, Marinara Extender's YAML storage structure needs to integrate the TOKI operator algebra framework. TOKI promotes agent facts onto a flat bitemporal table with a clearly lineated row structure. Every state transformation of a memory is not executed via direct overwrite, but is recorded as a new event row. The system utilizes an implicit check-bound filter based on the row_kind column to segregate active records (current) from historical audit records (audit). 

No.

Index Column Name

Data Type

System Role and Meaning

1

fact_id

TEXT

Primary key identifying the memory entity (combined with column 7). 

2

subject

TEXT

The subject entity of the memory. 

3

predicate

TEXT

The relational attribute/link. 

4

object

TEXT

The recorded factual content. 

5

valid_from

TIMESTAMP

Narrative validity start timestamp ($V_t$). 

6

valid_to

TIMESTAMP

Narrative validity end timestamp ($V_t$). 

7

system_time_start

TIMESTAMP

Timestamp when the system recorded the entry into the database ($S_t$). 

8

system_time_end

TIMESTAMP

Timestamp when the system closed the record or updated to a new state ($S_t$). 

9

provenance_id

TEXT

Link key for data extraction lineage (K-relation). 

10

confidence

DOUBLE

Memory confidence weight within the range $[0, 1]$. 

11

resolution_strategy_id

TEXT

Identifier of the applied conflict resolution algorithm. 

12

row_kind

TEXT

Implicit check-bound filter separating active status (current / audit). 

To resolve information conflicts sharing the same subject-predicate key, the TOKI isolation gateway applies four bitemporal operators based on data characteristics: 

Last-Writer-Wins (LWW) Operator: Employed for simple physical attributes; the system automatically sets the timestamp of the new record entry as the expiration time ($valid\_to$) of the old record, moving the old record to the audit state. 

Evidence-Weighted Merge Operator: Accumulates the confidence score of a fact based on its frequency of appearance across scenes. 

Await-Confirmation Operator: Suspends conflicting facts in a moderation queue for direct author approval. 

Per-Rule Policy Operator: Applies pre-configured hard logical constraint rules for the story world. 

The Audit-Row Defense mechanism guarantees that facts which fail during the arbitration process are not physically expunged from the YAML file. The legacy row will be stored with the label row_kind = audit, accompanied by a linked hash signature so that the language model can re-query the character's entire history of cognitive transitions when necessary, thoroughly resolving replay inconsistency and belief-drift skew errors. 

Strategies for Resolving Data Bloat and Optimizing Performance 

Storing the entire history of factual mutations as immutable event streams rapidly inflates the size of YAML files on the hard drive. To sustain optimal read/write performance on local hardware, Marinara Extender simultaneously implements three infrastructure optimization solutions: 

In-Memory YAML Cache and Delayed Write Queue 

The system completely resolves hard drive bottlenecks by deploying an In-Memory YAML Cache combined with an Asynchronous Write Queue. Upon sidecar server initialization, the entire index structure from index.yaml is loaded into RAM as optimized Map objects. Every query request from Marinara Engine is served directly from this RAM cache with near-zero latency. Every write or update request is pushed into a job queue managed by a debounce mechanism. Every 30-second cycle, the system batches the queued write requests, synchronizes data in RAM, and executes a single write-to-disk operation, preserving YAML transparency while ensuring peak performance. 

Context Allocation Mechanism Based on the Knapsack Algorithm 

When integrating memory into the context window of a large language model, the system applies a core mechanism based on the Knapsack Problem. Rather than utilizing a fixed number of messages, the system measures the actual token footprint of each context segment based on the specific tokenizer of the active model. The context budget is dynamically allocated according to a strict priority hierarchy: 

Priority 1 (System Prompt and Character Card): Maintained static to preserve character identity. 

Priority 2 (Most Recent Chat Turns): Preserved intact to maintain direct conversational flow. 

Priority 3 (Retrieved Long-Term Memories): Loaded dynamically based on similarity scores and memory strength. 

Priority 4 (Legacy Conversation History): Utilizes the remaining budget headroom. 

When the cumulative volume exceeds the context window constraint, the system applies a "middle-out pruning" technique. Instead of slicing away the beginning or the end, the system prunes messages from the middle of the dialogue—where the least critical information resides—to retain the core system context at the top and the newest developments at the tail. Simultaneously, the system continuously maintains a 10% safety buffer below the model's physical context ceiling to completely prevent context overflow errors that trigger abrupt memory loss. 

Backup Integrity, Security, and Network Compatibility 

To prevent physical disk failure incidents or unauthorized external data modifications, Marinara Extender's super memory system implements a cryptographic Hash-Chained Ledger mechanism combined with secure IP range whitelisting. The system runs a scheduled background daemon during nighttime. Whenever a memory event row or a completed scene is appended to the immutable ledger, the system establishes a cryptographic link. The latest event row ($Node_i$) must embed a SHA-256 hash computed from its own content combined with the hash of the immediately preceding event row ($Node_{i-1}$): 

$$H_i = \text{SHA-256}\left(H_{i-1} \parallel \text{Node}_i.\text{data}\right)$$

This mechanism constructs an immutable cryptographic chain running across the entire storage history. When the physical backup routine is invoked via the /api/backup API, the system evaluates structural integrity by replaying the hash log across the entire chain. If any discrepancy between the calculated hash and the recorded hash is detected, the system immediately aborts the backup process and throws a data corruption alert, completely eliminating any possibility of state drift (zero drift). 

Additionally, the sidecar's security layer is tightly built around execution environment isolation and request origin validation. By default, the sidecar server binds exclusively to the loopback address 127.0.0.1. To accommodate user scenarios running Marinara Engine across a LAN or inside Docker environments, the MARINARA_EXTENDER_ALLOWED_ORIGIN environment variable is leveraged to register additional trusted request origins, thwarting Cross-Site Request Forgery (CSRF) attacks. Any remote connection must pass through a Basic Authentication barrier and supply an administrative secret key (ADMIN_SECRET) for sensitive routines like backup generation or system maintenance. Notably, the system automatically trusts and bypasses authentication for the Tailscale network IP range (100.64.0.0/10) and the Docker bridge network (172.16.0.0/12) to facilitate seamless deployment of secure home servers. 

Proposed Technical Integration Roadmap for the Extender Project 

To materialize the aforementioned theoretical solutions into a resilient codebase for Marinara Extender, the development roadmap is proposed across four rigorous technical execution stages: 

Step 1: Migration to Unlabeled Background Extraction 

Developers must completely eliminate dependencies on command tags such as [bookmark:] or [remember:] generated by the primary model. Establish an asynchronous background worker process running natively on the sidecar server. Upon receiving chat turn data from the interface via the /api/process-turn API, this worker forwards the message payload to a local Dolphin language model with a specialized prompt to automatically extract new facts, user habits, or narrative threads that require tracking, ensuring continuous information gathering without diluting the agent's primary text generation stream. 

Step 2: Implementation of RAM Cache and Hybrid Storage Architecture 

Integrate an In-Memory Hybrid Cache layer directly into the Node.js source code of the sidecar server. At server startup, all index data from index.yaml is fetched into RAM as optimized Map data structures. Semantic similarity search routines are executed by calculating cosine distance via a lightweight, RAM-based linear vector math library, eliminating all external dependencies on expensive cloud-hosted vector database services. The disk writing pipeline will be governed by a debounced write queue with a 30-second synchronization cycle to safeguard storage hardware longevity and maintain peak local system efficiency. 

Step 3: Deployment of a Flat Entity Indexer and Graph Constraint Validation 

Developers must construct a unified entity index file structured as entities.yaml to interlink multi-hop relationships. When a character or event is invoked, the system bypasses crude raw keyword matching to automatically traverse the entity map, pulling all associated associative memories into the active context of the Lorebook. Simultaneously, for long-form narrative composition purposes, the system must integrate a lightweight mathematical Constraint Logic Solver. Whenever a modification occurs on the storyline Directed Acyclic Graph (DAG), this validator scans all diverging branches to guarantee that no spatial, temporal, or character state contradictions persist before proceeding with narrative generation. 

Step 4: Integration of TOKI Operator Algebra and Audit-Row Defense 

Upgrade Marinara Extender's conflict resolution codebase by implementing the formalized TOKI operator definitions. The system must be engineered to automatically detect cognitive dissonance events mapped to the subject-predicate key. Upon detecting a conflict, instead of overwriting and entirely erasing the legacy information—which risks an audit loss—the system instantiates a new record with an updated validity timestamp, while relegating the historical entry to a subordinate array designated as audit_history nested directly within that specific entity's YAML file structure. This combination empowers the language model to retrieve an unprecedented chronicle of cognitive shifts, enabling literary creations to reach unparalleled psychological depth and flawless logical coherence in character development. 



