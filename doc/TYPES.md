# Common Event Types/Names

> There is a central event registry which is editable by the administration.

## Rules:

events are past tense
event names are stable
breaking schema changes create new versions
deprecated events remain readable forever
organizations can define local namespaces

----

## Format

<domain>.<entity>.<verb>

----

## Defaults

chat.message.posted
chat.message.edited
task.item.created
task.item.assigned
identity.role.granted
device.telemetry.received
church.prayer.requested

----

## Querying

Querying the event log is simply writing SQL.
