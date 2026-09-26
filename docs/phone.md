# Phone automation (CMB-17)

The phone fires on a geofence four miles before the fork, calls the verdict
service, and speaks the answer over the car audio. Weekday mornings only.

## Recommendation: MacroDroid

MacroDroid, because every step below is a named, fill-in-the-form building
block (Geofence Trigger, HTTP Request with header params and a return-code
variable, JSON Parse, Speak Text with a selectable audio stream, Day of Week
and Time of Day constraints) and needs no variable syntax to learn. Tasker can
do the same and is more capable, but the HTTP-to-JSON-to-speech chain needs
its Structured Output option and `%http_data.spoken` notation, which is more
to get wrong in fifteen minutes.

Both are one-time purchases: MacroDroid Pro about $5.50 (free tier has a
macro limit and ads; 7-day Pro trial), Tasker about $4.50 (paid up front).
Neither is a subscription.

## Where the trigger point is

The fork is `[route.decision_point]` in your `config.toml` (gitignored, never
in this repo). The trigger point is `[trigger] lead_miles` (4.0) before it
along the inbound road. Open the decision point in a map, follow your route
back four miles, and drop the geofence pin on the roadway itself. Read both
values from the file; nothing in this document or the repo carries them.

## Before building: permissions that make geofences fire

1. Settings > Apps > MacroDroid > Permissions > Location: **Allow all the
   time** (not "only while using"). Also enable Precise location.
2. Settings > Apps > MacroDroid > Battery: **Unrestricted**. On Samsung also
   remove MacroDroid from Sleeping apps and Deep sleeping apps.
3. Settings > Location: on, with Google Location Accuracy (Wi-Fi and
   Bluetooth scanning) on. Geofences are Google Play services geofences, so
   they need Play services and Location Accuracy.
4. Settings > Apps > MacroDroid > Notifications: allow, so its foreground
   service is not killed.

## Import instead of building by hand

`docs/switchtender.macro` is the whole macro as a MacroDroid export. It began
as a file generated against MacroDroid's own AI schema (v1.0, app 5.60+),
was installed on the owner's phone through remote.macrodroid.com on
2026-09-16, edited there, and exported back; the committed file is that
export with run-time values blanked. Two ways in:

- **Web:** sign in at https://remote.macrodroid.com, connect the phone,
  Macros tab, `Import macro / category…`, pick the file.
- **Phone:** copy the file to the phone and open it; MacroDroid imports it.

The macro keeps its two deployment-specific values in local variables so the
body itself carries nothing private:

- `st_url` is prefilled with the public service URL. Change it if the service
  moves.
- `st_key` is empty. On the phone, set it to the value of 1Password item
  `Switchtender shared secret` (vault `Software_Development`, field
  `credential`). MacroDroid's system log prints variable changes in plain
  text, so mark the variable secure if the app offers it.

Then tap the Geofence trigger, create a zone, drop the pin on the inbound
road four miles before the fork, radius 400 m. The export deliberately
carries no zone: a geofence describes the commute. Enable the macro and Run
it once at your desk on Bluetooth. Everything else (weekday and time
constraints, HTTP request, JSON parse, speech on the Music stream, failure
branch) is already in place. The manual recipe below is the same macro,
step by step, for reference or for Tasker.

## Recipe (MacroDroid)

1. Add Macro. Name it `Switchtender`.
2. **Trigger** > Location > **Geofence Trigger**. Add a geofence: drag the
   pin to the trigger point, radius **400 m** (see below), name it
   `Switchtender trigger`. Event: **Area Entered**. Loitering delay: 0.
3. **Action** > Connectivity > **HTTP Request**.
   - Method: `GET`
   - URL: `https://<service>/verdict`, the host from `docs/deploy.md`
   - Header Parameters: add one. Key `X-Switchtender-Key`, Value: the shared
     secret, pasted from 1Password item `Switchtender shared secret`
     (vault `Software_Development`, field `credential`).
   - Timeout: **25** seconds.
   - Block next action until complete: **on**.
   - Save HTTP Return Code to integer variable `st_code` (create it, local).
   - Save HTTP Response to string variable `st_body` (create it, local).
4. **Action** > Control Flow > **If**: `st_code` (Integer Variable) **=**
   `200` **AND** `st_body` (String Variable) **is not** empty.
5. Inside the If: **Action** > Data > **JSON Parse**. Input: `st_body`.
   Output dictionary variable: `st_json` (create it, local, type
   Dictionary).
6. **Action** > Device Actions > **Speak Text**. Text: `{lv=st_json[spoken]}`
   (use the `...` magic-text button and pick the `spoken` key of `st_json`
   rather than typing it). Audio stream: **Music**. Queue behaviour: Flush.
7. **Else**: **Speak Text** with the literal `Switchtender lookup failed`,
   audio stream Music. **End If**.
8. **Constraints**: add **Day of the Week** with Mon, Tue, Wed, Thu, Fri
   ticked, and **Time of Day** from `05:30` to `10:00`. Both are plain
   fields; edit them when the commute moves.
9. Save. Test with Test Actions (the play icon) at your desk with the phone
   on Bluetooth: you should hear the current verdict.
10. Test the geofence for real once, on a weekday, at speed. If it fires late
    or not at all, first widen the radius, then move the pin further out.

Validated on a real drive 2026-09-21: the geofence fired unattended at the
trigger point at speed, the call returned, and the verdict was spoken with
enough road left to act on it. No radius or pin change was needed.

Do not export or share this macro to MacroDroid's template store. The secret
sits in it as plain text.

## Arrival macros (CMB-41)

The fork macro says what the engine predicted. Two more geofences say what
actually happened, so a verdict can be scored. They are what makes the log
worth tuning against; without them every row is a prediction with no outcome.

Build one macro per place. Both are the same three blocks:

1. **Trigger** > Location > **Geofence Trigger**, Area Entered, loitering
   delay 0. One fence on the park-and-ride lot, one on the office. Name them
   `Switchtender arrived park` and `Switchtender arrived office`.
2. **Action** > Applications > **HTTP Request**. Method **POST**, URL
   `https://<service>/arrived?place=park` (or `?place=office`), one header
   parameter `X-Switchtender-Key` with the shared secret. No body. The
   service has no response for the macro to read, so no JSON parse and no
   Speak Text: an arrival is silent.
3. **Constraints**: none needed. The server ignores a second arrival for the
   same place on the same local date, so a lunch trip that re-enters the
   office fence changes nothing, and a fence that fires twice on one approach
   records once.

Radius is not the fork's 400 m. That number exists because a car at 60 mph
needs a wide fence to catch a background location fix; arriving at a lot or a
door happens at walking pace and the fix has time. Start at **150 m**, the
smallest this API is reliable at, and widen only if an arrival goes missing.
A tight fence matters here: the arrival time is the measurement, and a fence
that fires a quarter mile out records a time that was never true.

The arrival time may also be supplied as `&at=<ISO 8601>` when the macro
queues a request offline and sends it late. Without it the server uses the
moment the request landed.

### Saying which option was actually taken

`&took=drive|transit` records what was done, which is not the same as what the
verdict advised: the advice can be ignored, and a row that cannot say which
option was taken cannot be scored against either estimate. Left out, the
column stays empty, and an empty one is honest — a guess would look like
evidence.

The phone can know this without being asked. Park-and-ride always passes
through the lot, so the park fence firing is the fact that decides it:

1. In the park macro, before the HTTP Request, add **Variables** > **Set
   Variable**: a global string `st_took`, value `transit`. Send the park
   arrival with `&took=transit`.
2. In the office macro, send `&took={v=st_took}` (use the magic-text button;
   see the dictionary note below for why the braces matter). Then add a
   second **Set Variable** action after it that clears `st_took` back to
   `drive`, ready for tomorrow.
3. Keep the default value of `st_took` as `drive`. A morning with no park
   arrival is a morning that drove through, which is exactly what the
   default then reports.

A morning that broke the pattern — parked and then gave up and drove, a lift
from someone else — is worth correcting by hand in the sheet rather than
modelling in the macro.

## Geofence radius

Start at **400 m**. Play services geofences fire on the next location fix
after the boundary, which in the background can be tens of seconds behind; at
60 mph that is up to a half mile. 400 m at that speed is about fifteen seconds
inside the fence, enough for a fix. Under 150 m is unreliable in this API. If
the announcement lands too close to the fork, move the pin out rather than
raising `lead_miles`: the service only uses `lead_miles` as a description.

400 m at `lead_miles = 4.0` is confirmed in practice (2026-09-21 drive).

## Car audio and Android Auto

Speak Text on the **Music** stream plays through the car over Bluetooth
A2DP and through Android Auto (USB or wireless). Music ducks or pauses for
the length of the sentence, then resumes. The two known caveats:

- The Notification and Ringer streams often do not reach the head unit at
  all (some cars route them to the phone speaker). Keep the stream on Music.
  If MacroDroid Settings has "Spoken Text Audio Stream", set it to Music too.
- Volume is the car's media volume. If a podcast is quiet the verdict is
  quiet. There is no per-app volume; do not add a Set Volume action, it
  would also change the podcast.

Android Auto does not need to know about the macro. Neither app can detect
that Android Auto itself is running; if you ever want an "in the car"
constraint, use Bluetooth Device Connected with the car's name.

## The secret

Neither MacroDroid nor Tasker can read a field from 1Password or Bitwarden at
run time. Both password managers expose autofill to Android, not a query API,
and neither ships a Tasker plugin. The secret is pasted once into the header
value, so it lives in the app's database on the phone. To rotate:

```
scripts/deploy-cloud-run.sh --rotate-secret
```

then open the macro, the HTTP Request action, and repaste the new value from
the 1Password item. Until you do, the call returns 401 and the phone says
"Switchtender lookup failed".

## Alternative: Tasker

Same shape, different names. Profile: **Location** (Tasker's own monitor;
set radius about 400 m) or the AutoLocation plugin's Geofence, plus a
**Time** context 05:30 to 10:00 and **Day** context Mon to Fri. Task: **HTTP
Request** (Method GET, URL as above, Headers `X-Switchtender-Key:<secret>`,
Timeout 25, Structured Output on) then **If** `%http_response_code eq 200`
and `%http_data` set, **Say** `%http_data.spoken` on stream Music, **Else**
Say `Switchtender lookup failed`, **End If**. Tasker's built-in Location
context can be steered onto cell towers for less battery, and it has a decade
of Doze workarounds; if MacroDroid's geofence proves flaky on your phone, this
is the second thing to try.

## Fallback if geofences prove unreliable

Per the ticket: if the geofence misses more mornings than it catches, swap
the trigger for a time one. MacroDroid **Day/Time Trigger** at the minute you
usually pass the trigger point, same constraints and actions. Cheaper, no
location permission, and wrong by however early or late you left. Keep the
geofence macro disabled rather than deleted so you can flip back.
