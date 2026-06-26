# Database Schema

## Events

```
EventType {
  namespace: "chat"
  name: "message.posted"
  version: 1
  schema: JsonSchema
  owner: "comms-team"
  status: "active" | "deprecated"
}

Event {
  
```

## Twins

```
TwinType {
  "name": <string>,
  "serialNumber": <string>,
  "model": <string>,
  "locationId": twin.id
}

Twin {
  
