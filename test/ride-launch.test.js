// Tests for the Job launch (src/ride/launch.js). No network: the Run API is a
// stub fetch, and the environment is an object handed in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rideEnv, jobRunUrl, launchRide, RIDE_BUCKET_ENV, RIDE_JOB_PROJECT_ENV, RIDE_JOB_REGION_ENV, RIDE_JOB_NAME_ENV } from '../src/ride/launch.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('rideEnv names the first missing variable and defaults the region and the job name', () => {
  assert.deepEqual(rideEnv({}), { ok: false, error: 'RIDE_BUCKET is not set' });
  assert.deepEqual(rideEnv({ [RIDE_BUCKET_ENV]: 'b' }), { ok: false, error: 'RIDE_JOB_PROJECT is not set' });
  assert.deepEqual(rideEnv({ [RIDE_BUCKET_ENV]: ' b ', [RIDE_JOB_PROJECT_ENV]: 'p\n' }), {
    ok: true,
    bucket: 'b',
    project: 'p',
    region: 'us-east4',
    job: 'switchtender-ride',
  });
  assert.deepEqual(rideEnv({ [RIDE_BUCKET_ENV]: 'b', [RIDE_JOB_PROJECT_ENV]: 'p', [RIDE_JOB_REGION_ENV]: 'us-central1', [RIDE_JOB_NAME_ENV]: 'ride-x' }), {
    ok: true,
    bucket: 'b',
    project: 'p',
    region: 'us-central1',
    job: 'ride-x',
  });
  assert.equal(jobRunUrl({ project: 'p', region: 'r', job: 'j' }), 'https://run.googleapis.com/v2/projects/p/locations/r/jobs/j:run');
});

test('launchRide posts the :run body with RIDE_KEY and RIDE_BUCKET overrides and returns the operation', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return json(200, { name: 'projects/p/locations/r/operations/op-1', metadata: {} });
  };
  const env = { ok: true, bucket: 'rides-bucket', project: 'p', region: 'r', job: 'j' };
  const result = await launchRide({ env, rideKey: 'rides/2026-10-21-am.json', token: 'tok', fetchImpl });
  assert.deepEqual(result, { ok: true, operation: 'projects/p/locations/r/operations/op-1', error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://run.googleapis.com/v2/projects/p/locations/r/jobs/j:run');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    overrides: {
      containerOverrides: [
        {
          env: [
            { name: 'RIDE_KEY', value: 'rides/2026-10-21-am.json' },
            { name: 'RIDE_BUCKET', value: 'rides-bucket' },
          ],
        },
      ],
    },
  });
});

test('a refused or unreachable Run API is reported, never thrown', async () => {
  const env = { ok: true, bucket: 'b', project: 'p', region: 'r', job: 'j' };
  const refused = await launchRide({
    env,
    rideKey: 'k',
    token: 'tok',
    fetchImpl: async () => json(403, { error: { message: 'Permission denied on resource' } }),
  });
  assert.deepEqual(refused, { ok: false, operation: null, error: 'run 403: Permission denied on resource' });
  const down = await launchRide({
    env,
    rideKey: 'k',
    token: 'tok',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(down, { ok: false, operation: null, error: 'network (TypeError): fetch failed' });
  const odd = await launchRide({ env, rideKey: 'k', token: 'tok', fetchImpl: async () => new Response('', { status: 200 }) });
  assert.deepEqual(odd, { ok: true, operation: null, error: null });
});
