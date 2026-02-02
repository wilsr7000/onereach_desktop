# Omnical API Documentation

API endpoint for fetching Google Calendar events via OneReach flow.

## Endpoint

```
POST https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical
```

## Request

### Method
**POST** (required - GET will not work)

### Headers
```
Content-Type: application/json
```

### Body (JSON)

**All fields are required**, even if empty. Omitting fields will cause errors.

```json
{
  "method": "",
  "startDate": "Feb 2 2026",
  "endDate": "Feb 16 2026",
  "startTime": "",
  "endTime": "",
  "searchText": "",
  "timeZone": "America/Los_Angeles"
}
```

### Field Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `method` | string | Yes | Leave empty string `""` |
| `startDate` | string | Yes | Start date in natural language format (see below) |
| `endDate` | string | Yes | End date in natural language format (see below) |
| `startTime` | string | Yes | Start time, or empty string `""` for start of day |
| `endTime` | string | Yes | End time, or empty string `""` for end of day |
| `searchText` | string | Yes | Filter by text, or empty string `""` for all events |
| `timeZone` | string | Yes | IANA timezone (e.g., `America/Los_Angeles`) |

### Date Format

The API uses OneReach's `timeInterpreter` which accepts natural language dates:

**Supported formats:**
- `Feb 2 2026` (recommended)
- `February 2, 2026`
- `02/02/2026`
- `2026-02-02`

**NOT supported:**
- `today`, `tomorrow`, `in 2 weeks` (relative dates don't work)
- ISO 8601 with time: `2026-02-02T00:00:00Z`

### Time Format

If specifying times:
- `12:00 AM`, `9:00 AM`, `11:59 PM`
- `00:00`, `09:00`, `23:59`

Leave empty (`""`) to include all events for the day.

## Response

### Success (events found)
```json
[
  {
    "kind": "calendar#event",
    "id": "abc123...",
    "status": "confirmed",
    "summary": "Meeting Title",
    "description": "Meeting description...",
    "location": "https://zoom.us/...",
    "start": {
      "dateTime": "2026-02-03T09:00:00-08:00",
      "timeZone": "America/New_York"
    },
    "end": {
      "dateTime": "2026-02-03T10:00:00-08:00",
      "timeZone": "America/New_York"
    },
    "attendees": [...]
  },
  ...
]
```

### No events found
```json
{"result": "not found"}
```

### Error responses

| Error | Cause | Solution |
|-------|-------|----------|
| `Start date is invalid.` | Missing `startDate` field or unparseable format | Include `startDate` with valid format |
| `End date is invalid.` | Missing `endDate` field or unparseable format | Include `endDate` with valid format |
| `Start time is invalid.` | `startTime` field present but unparseable | Use valid time format or empty string |
| `End time is invalid.` | `endTime` field present but unparseable | Use valid time format or empty string |
| `{"error":"no handler"}` | Wrong HTTP method (GET instead of POST) | Use POST method |

## Common Mistakes

### 1. Using GET instead of POST
```bash
# WRONG - returns error
curl "https://...omnical"

# CORRECT
curl -X POST -H "Content-Type: application/json" -d '...' "https://...omnical"
```

### 2. Omitting required fields
```json
// WRONG - missing fields causes "Start date is invalid"
{"startDate": "Feb 2 2026", "endDate": "Feb 16 2026"}

// CORRECT - include ALL fields
{"method":"","startDate":"Feb 2 2026","endDate":"Feb 16 2026","startTime":"","endTime":"","searchText":"","timeZone":"America/Los_Angeles"}
```

### 3. Using form-urlencoded instead of JSON
```bash
# WRONG - may cause parsing issues
curl -X POST -d 'startDate=Feb+2+2026&...' "https://...omnical"

# CORRECT - use JSON
curl -X POST -H "Content-Type: application/json" -d '{"startDate":"Feb 2 2026",...}' "https://...omnical"
```

### 4. Using relative dates
```json
// WRONG - timeInterpreter doesn't support these
{"startDate": "today", "endDate": "in 2 weeks", ...}

// CORRECT - use absolute dates
{"startDate": "Feb 2 2026", "endDate": "Feb 16 2026", ...}
```

## Example: Fetch next 2 weeks of events

```javascript
const fetchCalendarEvents = async () => {
  const now = new Date();
  const twoWeeksLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  
  const formatDate = (d) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
  };
  
  const response = await fetch(
    'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: '',
        startDate: formatDate(now),
        endDate: formatDate(twoWeeksLater),
        startTime: '',
        endTime: '',
        searchText: '',
        timeZone: 'America/Los_Angeles'
      })
    }
  );
  
  const data = await response.json();
  
  // Handle "not found" response
  if (data?.result === 'not found') {
    return [];
  }
  
  return Array.isArray(data) ? data : [];
};
```

## Example: curl command

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"method":"","startDate":"Feb 2 2026","endDate":"Feb 16 2026","startTime":"","endTime":"","searchText":"","timeZone":"America/Los_Angeles"}' \
  "https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical"
```

## Calendar Details

- **Calendar ID**: `robb@onereach.com`
- **Authorization**: Google OAuth 2.0 (configured in OneReach flow)
- **Scopes**: `calendar`, `calendar.events`

## Related Files

- Calendar Agent: `packages/agents/calendar-agent.js`
- Flow Source: OneReach Studio > Omni Data > Omni Calendar List
