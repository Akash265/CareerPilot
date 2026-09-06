# AI Career Intelligence — Claude Code Instructions

## 1. Project Context

This is a greenfield project for an **AI Career Intelligence & Application Platform**.

The repository currently contains only a project specification/description document. No application architecture, source code, database, frontend, backend, or AI agents have been implemented yet.

The project specification document is the primary source of truth for understanding the intended product.

Before making implementation decisions, read and understand the project specification thoroughly.

---

## 2. Core Development Principle

Do **not** immediately start writing application code.

This project should be developed systematically:

1. Understand the product requirements.
2. Analyze the specification and identify ambiguities or missing requirements.
3. Define the product scope and MVP.
4. Design the system architecture.
5. Select the technology stack.
6. Define the repository structure.
7. Define data models and system interfaces.
8. Define the AI/agent architecture.
9. Establish development and testing conventions.
10. Implement incrementally.

Do not make major architectural decisions without first understanding how they affect the complete system.

---

## 3. Project Specification

The existing project description document should be treated as the initial product specification.

When beginning work:

* Locate and read the project specification.
* Extract functional requirements.
* Extract non-functional requirements.
* Identify user workflows.
* Identify required integrations.
* Identify AI/LLM capabilities.
* Identify data sources.
* Identify expected inputs and outputs.
* Identify assumptions and constraints.
* Identify unclear or potentially conflicting requirements.

If the specification does not provide enough information for a technical decision, identify the gap rather than silently inventing a complex solution.

Reasonable engineering assumptions are acceptable, but significant assumptions should be explicitly documented.

---

# 4. Greenfield Project Rules

Because this is a new project:

* Do not assume existing architecture.
* Do not assume existing libraries or frameworks.
* Do not introduce technologies merely because they are popular.
* Prefer technologies that solve a clear project requirement.
* Keep the initial implementation understandable and maintainable.
* Avoid premature microservices.
* Avoid unnecessary abstractions.
* Avoid unnecessary dependencies.
* Prefer a modular monolith initially unless the requirements clearly justify otherwise.
* Design components so they can be separated later if the project grows.

The MVP should be achievable without building an unnecessarily complicated infrastructure.

---

# 5. Architecture Before Implementation

Before substantial coding begins, establish an initial architecture covering at least:

### Frontend

Determine:

* Framework
* UI architecture
* State management
* API communication
* Authentication
* File uploads
* User workflows
* Job search/results interface
* Career intelligence dashboard

### Backend

Determine:

* API framework
* Service boundaries
* Authentication
* Authorization
* Background jobs
* Error handling
* API contracts
* External integrations

### AI / Agent Layer

Determine how the platform will use LLMs for capabilities such as:

* Resume analysis
* Job description analysis
* Career goal interpretation
* Candidate-job matching
* Skill-gap analysis
* Job ranking
* Application recommendations
* Personalized explanations
* Career insights

Avoid creating an "agent" simply because an LLM is involved.

Use deterministic code where deterministic code is more appropriate.

Use LLMs where reasoning, extraction, classification, generation, or semantic matching provides genuine value.

### Data Layer

Determine:

* Primary database
* Vector/semantic search requirements
* Data models
* Job posting storage
* Resume/profile storage
* Application history
* Skills
* Companies
* Job requirements
* Matching results
* AI-generated insights

### Data Ingestion

Determine how job postings and other external information enter the system.

Clearly separate:

* ingestion
* normalization
* enrichment
* storage
* retrieval
* ranking

Do not tightly couple external job sources to the rest of the application.

---

# 6. AI Engineering Principles

AI functionality must be designed as a reliable software system rather than a collection of prompts.

For important AI operations:

* Define structured inputs.
* Define structured outputs.
* Use schemas where appropriate.
* Validate model outputs.
* Handle malformed outputs.
* Handle missing information.
* Track model failures.
* Avoid unnecessary LLM calls.
* Keep prompts versionable.
* Separate prompts from application logic where practical.
* Make important AI decisions explainable to the user.
* Prefer deterministic logic for straightforward rules.

Where possible, AI-generated results should contain enough information to explain **why** a recommendation was made.

For example, a job match should ideally distinguish between:

* strong skill match
* partial skill match
* missing skills
* experience match
* location match
* sponsorship compatibility
* seniority match
* other relevant constraints

Do not present an opaque numerical score as the sole explanation for an important recommendation.

---

# 7. Career Goal Input

The platform should prioritize a natural-language **Career Goal Statement** rather than forcing users to configure a large number of rigid filters.

For example:

> "I want data professional roles in Germany or the UK, preferably fully remote, with visa sponsorship, and requiring at least 3 years of experience."

The system should be capable of converting this into structured requirements such as:

```text
locations
roles
seniority
experience
remote preference
visa sponsorship
employment type
skills
salary requirements
other constraints
```

The original user statement should be preserved so the system can explain how it interpreted the user's goal.

The architecture should allow users to review and correct the interpreted requirements.

---

# 8. Data Quality

Job data may be incomplete, duplicated, outdated, inconsistent, or contradictory.

The system should account for:

* duplicate jobs
* expired jobs
* missing fields
* inconsistent job titles
* inconsistent locations
* duplicate companies
* conflicting salary information
* stale job postings
* unreliable sponsorship information

Do not assume external job data is clean.

Data quality logic should be separated from the UI and AI reasoning layers.

---

# 9. Privacy and Security

The platform may process sensitive career-related information such as resumes, employment history, contact information, and application history.

Therefore:

* Do not log resume contents unnecessarily.
* Do not expose personal information in debugging output.
* Never commit secrets.
* Use environment variables for credentials.
* Provide appropriate access controls.
* Minimize stored personal data.
* Design file storage securely.
* Validate uploaded files.
* Treat external content as untrusted input.
* Protect against prompt injection from job descriptions, resumes, websites, and other external content.

Never place API keys, tokens, passwords, or credentials directly in source code.

---

# 10. Testing

Use a test-driven approach where practical.

For new functionality:

1. Define expected behavior.
2. Write appropriate tests.
3. Implement the functionality.
4. Run tests.
5. Fix failures.
6. Refactor if necessary.

Testing should include:

### Unit tests

For:

* parsers
* data transformations
* matching logic
* scoring logic
* validation
* utility functions

### Integration tests

For:

* API endpoints
* database interactions
* ingestion pipelines
* AI services
* external integrations

### AI evaluation

AI features should not rely only on conventional unit tests.

Where appropriate, create evaluation datasets for:

* resume extraction
* job extraction
* career-goal parsing
* job matching
* skill-gap analysis
* recommendation quality

AI behavior should be evaluated for both accuracy and consistency.

---

# 11. Development Workflow

Use the following workflow for significant features:

### Step 1 — Understand

Inspect the relevant specification and existing implementation.

### Step 2 — Plan

Describe:

* objective
* requirements
* affected components
* architecture
* data changes
* API changes
* testing strategy
* risks

### Step 3 — Review

Before implementing a significant architectural change, present the plan and identify important trade-offs.

### Step 4 — Implement

Implement in small, logically separated increments.

### Step 5 — Test

Run relevant tests and validation.

### Step 6 — Review

Check:

* correctness
* security
* maintainability
* performance
* error handling
* unnecessary complexity

### Step 7 — Document

Update documentation when architecture, setup, APIs, or important behavior changes.

---

# 12. Superpowers Workflow

Superpowers is installed in this project and should be used when its skills are relevant.

Follow disciplined software-engineering practices rather than treating Claude as an unrestricted code generator.

For complex tasks:

* understand the problem first
* investigate the repository
* establish requirements
* create an implementation plan
* break work into manageable tasks
* implement incrementally
* test continuously
* review the result

Do not skip planning merely because the requested feature appears simple.

However, do not create unnecessary planning overhead for trivial changes.

---

# 13. Repository Structure

Do not create the final repository structure blindly.

First determine the architecture from the project specification.

Once the architecture is established, maintain a clean separation between concerns.

A possible structure may eventually resemble:

```text
ai-career-intelligence/
│
├── frontend/
│
├── backend/
│
├── ai/
│
├── ingestion/
│
├── database/
│
├── tests/
│
├── docs/
│
├── scripts/
│
├── .env.example
├── .gitignore
├── CLAUDE.md
└── README.md
```

This is an example, **not a requirement**.

Choose the actual structure based on the final architecture.

---

# 14. Technology Selection

Technology choices should be driven by project requirements.

Before selecting the stack, consider:

* development speed
* ecosystem maturity
* AI/LLM integration
* type safety
* maintainability
* deployment complexity
* database requirements
* scalability
* testing support
* developer experience
* cost

Do not add a technology simply because it is currently fashionable.

When two technologies solve the requirement equally well, prefer the simpler one.

Document significant technology decisions and their rationale.

---

# 15. Git Rules

Use Git from the beginning.

* Create small, meaningful commits.
* Keep commits focused.
* Do not commit secrets.
* Do not commit `.env` files containing credentials.
* Do not rewrite shared history.
* Do not force push.
* Do not create commits unless explicitly requested by the user.

Before making large changes, inspect the current Git status.

---

# 16. Documentation

Maintain useful project documentation.

At minimum, the project should eventually contain:

```text
README.md
docs/
├── architecture.md
├── development.md
├── api.md
└── ai-system.md
```

Only create documents when they provide useful information.

Documentation should describe the actual implementation rather than an aspirational architecture that has not been built.

---

# 17. Communication Rules

When working on the project:

* State what you understand before implementing complex changes.
* Clearly identify assumptions.
* Highlight important trade-offs.
* Warn about potentially risky architectural decisions.
* Do not hide errors.
* Do not claim something works unless it has been tested.
* Distinguish between implemented, tested, and planned functionality.

If requirements are genuinely ambiguous and the decision would materially affect architecture or product behavior, ask for clarification rather than guessing.

For minor implementation details, make a reasonable engineering decision and continue.

---

# 18. Current Project State

At the beginning of this project, assume:

```text
Project status: GREENFIELD

Application code: None
Frontend: Not implemented
Backend: Not implemented
Database: Not implemented
AI agents: Not implemented
API: Not implemented
Tests: Not implemented
Deployment: Not implemented

Primary existing artifact:
Project specification document
```

Your first responsibility is therefore **understanding and designing the system**, not immediately generating large amounts of code.




# 19. DECISIONS.md — Rationale Log
Log every meaningful decision you make while changing the code, along with the reasoning behind it.

Include: why this library over alternatives, why this pattern, why a particular tradeoff was accepted.

Append or update DECISIONS.md in the repository root. Create it if missing.

# 20. FLOW.md — Traceability Map
Document how execution actually travels: between files, functions, and modules.

Show what calls what, in what order, and precisely which parts of that path you are modifying right now.

Update FLOW.md to reflect the current change. Create it if missing.

# 21. Own the Mental Model — Verification Step
After implementing changes, provide a concise summary of what changed and why.

Then ask the user to explain back, in their own words, the core logic and flow of the modified code.

Do not consider the task complete until the user demonstrates understanding. If they cannot, offer further explanation and re‑check.
 is the above claude.md file good enough for me to start the project

---

# 19. First Task

When Claude Code is first started in this repository, do the following:

1. Identify the project specification document.
2. Read it completely.
3. Summarize the product vision.
4. Extract the functional requirements.
5. Extract the major user workflows.
6. Identify the core technical capabilities required.
7. Identify ambiguities, risks, and missing requirements.
8. Propose an MVP scope.
9. Propose a high-level architecture.
10. Recommend the technology stack with reasoning.
11. Propose the initial repository structure.
12. Identify the major implementation phases.

**Do not start implementing the application yet.**

Present the findings and proposed architecture first.

Wait for approval before beginning substantial implementation.

