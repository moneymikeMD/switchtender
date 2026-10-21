// Launch the ride tracker, a Cloud Run Job, through the Run Admin API v2
// (CMB-151). The :run call returns a long-running operation as soon as the
// execution is created; that response is awaited, the execution is not,
// because the ride takes an hour and the request has 30 s.
//
// Where to find the Job and the bucket comes from the environment, read at
// call time (CLAUDE.md rule 7); see docs/configuration.md "Rides".

const RUN = 'https://run.googleapis.com/v2';

export const RIDE_BUCKET_ENV = 'RIDE_BUCKET';
export const RIDE_JOB_PROJECT_ENV = 'RIDE_JOB_PROJECT';
export const RIDE_JOB_REGION_ENV = 'RIDE_JOB_REGION';
export const RIDE_JOB_NAME_ENV = 'RIDE_JOB_NAME';
export const DEFAULT_JOB_NAME = 'switchtender-ride';
export const DEFAULT_JOB_REGION = 'us-east4';

const read = (env, name) => (typeof env[name] === 'string' ? env[name].trim() : '');

/**
 * Resolve the ride environment. { ok: true, bucket, project, region, job }
 * or { ok: false, error } naming the first variable that is missing.
 */
export function rideEnv(env = process.env) {
  const bucket = read(env, RIDE_BUCKET_ENV);
  if (!bucket) return { ok: false, error: `${RIDE_BUCKET_ENV} is not set` };
  const project = read(env, RIDE_JOB_PROJECT_ENV);
  if (!project) return { ok: false, error: `${RIDE_JOB_PROJECT_ENV} is not set` };
  const region = read(env, RIDE_JOB_REGION_ENV) || DEFAULT_JOB_REGION;
  const job = read(env, RIDE_JOB_NAME_ENV) || DEFAULT_JOB_NAME;
  return { ok: true, bucket, project, region, job };
}

/** The :run URL for a job. */
export const jobRunUrl = ({ project, region, job }) =>
  `${RUN}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}:run`;

/**
 * Start one execution with RIDE_KEY and RIDE_BUCKET in its environment.
 * Never throws: { ok: true, operation } or { ok: false, error }.
 */
export async function launchRide({ env, rideKey, token, fetchImpl = fetch, signal }) {
  const body = {
    overrides: {
      containerOverrides: [
        {
          env: [
            { name: 'RIDE_KEY', value: rideKey },
            { name: RIDE_BUCKET_ENV, value: env.bucket },
          ],
        },
      ],
    },
  };
  let response;
  try {
    response = await fetchImpl(jobRunUrl(env), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    return { ok: false, operation: null, error: `network (${cause?.name ?? 'Error'}): ${cause?.message ?? cause}` };
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    return { ok: false, operation: null, error: `run ${response.status}: ${json?.error?.message ?? response.statusText ?? 'request failed'}` };
  }
  return { ok: true, operation: typeof json?.name === 'string' ? json.name : null, error: null };
}
