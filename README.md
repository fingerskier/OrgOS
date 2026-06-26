# The Organization Operating System (OrgOS)

> **An open-source, decentralized operating system for organizations built upon an append-only event log.**
>
> Chat is not the product. Tickets are not the product. Wikis are not the product.
> **Events are the product.**

---

## Vision

Modern organizations are fragmented.

Messages live in Slack.
Code lives in GitHub.
Knowledge lives in Confluence.
Tasks live in Jira.
Meetings live in Google Calendar.
Sensors live on MQTT.
AI lives somewhere else.

Every system stores its own copy of reality.

**OrgOS inverts this model.**

There is only one reality:

> **A continuously growing stream of immutable events.**

Everything else is merely a projection.

---

## First Principles

### Reality is Events

Nothing changes.

Only new events are recorded.

```
UserCreated
MemberJoined
MessagePosted
PrayerRequested
IssueOpened
CommitMerged
AssessmentCompleted
SensorReadingReceived
InvoicePaid
DeviceOffline
```

The past is never rewritten.

History is preserved forever.

---

### State is Derived

There is no "database record."  Current state is computed from the event history.

```
Events
   ↓
Projection
   ↓
Current State
```

Need today's state?  Replay the events.

Need yesterday's state?  Replay to yesterday.

Need to audit?  Read the log.

---

### Everything is an Actor

Humans are actors.
AI agents are actors.
Devices are actors.
Organizations are actors.
Projects are actors.
Even workflows become actors.

```
Matt
Youth Ministry
Spectrum Kiosk #12
GitHub
Accounting AI
Church Calendar
Temperature Sensor
```

All speak the same language:

Events.

---

## Core Architecture

```
                    Organization

             ┌─────────────────────┐
             │ Identity & Trust    │
             └──────────┬──────────┘
                        │
        ┌───────────────▼────────────────┐
        │      Append-only Event Log     │
        └───────────────┬────────────────┘
                        │
      ┌─────────────────┼─────────────────┐
      │                 │                 │
  Projections      Automation       Federation
      │                 │                 │
      ▼                 ▼                 ▼
 Chat UI          AI Workers       Other Organizations
 Wiki             Rules Engine     Family
 Kanban           Workflows        Churches
 Timeline         Notifications    Businesses
 CRM              Integrations     Communities
 Dashboards
```

---

## Everything is a Projection

No application owns data.

Applications simply render the event log differently.

| Projection | Purpose |
|------------|---------|
| Chat | Conversations |
| Wiki | Living documentation |
| Timeline | Organizational history |
| Kanban | Task management |
| Calendar | Scheduled events |
| Dashboard | Metrics |
| CRM | Relationships |
| Knowledge Graph | Connected information |
| Digital Twin | Real-world systems |
| AI Workspace | Reasoning over events |

Every view originates from the same source.

---

## Federation

Organizations own their own data.

No central authority.

Servers federate similarly to email or Git.

```
Church A
     │
──── Federation ────
     │
Church B

Business

Family

School

Non-profit
```

Organizations choose what to share.
Ownership is cloistered.

---

## Local First

The network is optional.
Every node can operate independently.
Synchronization occurs whenever connectivity exists.
Offline is a first-class feature.

---

## AI as First-Class Citizens

AI is not a plugin.
AI is an organizational participant.

An AI has:
- identity
- permissions
- subscriptions
- memory
- tools
- conversations
- responsibilities
- accountability

AI publishes events exactly like humans.

```
IssueDetected
SummaryGenerated
PrayerReminderCreated
ScheduleOptimized
HardwareFailurePredicted
```

---

## Immutable History

Events cannot be modified.
Mistakes are corrected by new events.

```
DocumentCreated
↓
DocumentEdited
↓
DocumentCorrected
↓
DocumentArchived
```

Nothing disappears.
Everything is explainable.

---

## Permission Model

Permissions are themselves events.

```
RoleGranted
PermissionDelegated
AccessRevoked
OrganizationInvited
```

Authorization becomes reproducible and auditable.

---

## Extensibility

Everything communicates through events.
Applications subscribe to event streams.

```
GitHub
Stripe
Email
MQTT
PLC
LLM
Weather
IoT
REST
MCP
        │
        ▼
     Event Bus
```

No application requires special treatment.

---

## Digital Twins

Every real-world object may have a digital representation.

```
Person
Organization
Room
Device
Vehicle
Server
Sensor
Document
Project
```

Each twin evolves through events.

---

## Organizational Memory

The event log becomes institutional memory.

Instead of asking:
> "Where is that document?"

You ask:
> "Show me everything that has ever happened regarding this project."

The system reconstructs the answer.

---

## Core Values

- Open Source
- Decentralized
- Federated
- ~~Local First~~
- Event Sourced
- Immutable
- Offline Capable
- AI Native
- Human Centered
- Extensible
- Explainable
- Durable

---

## Long-Term Goal

Build the _Linux_ of organizational collaboration.
Not another chat application.
Not another project manager.
Not another wiki.

A foundational operating system upon which collaboration, automation, knowledge, AI, and organizational memory naturally emerge from a shared, append-only history of events.

---

## Motto

> **One history.  Infinite presentations.**
