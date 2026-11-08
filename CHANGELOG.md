# Changelog

## [1.11.0](https://github.com/moneymikeMD/switchtender/compare/v1.10.0...v1.11.0) (2026-11-08)


### Features

* [signals] switches turn events and track work off per deployment (CMB-126) ([#77](https://github.com/moneymikeMD/switchtender/issues/77)) ([68d3a17](https://github.com/moneymikeMD/switchtender/commit/68d3a1769db42300281938c7cebf2ca609540838))
* export buildConfig and a side-effect-free package entry (CMB-122) ([#75](https://github.com/moneymikeMD/switchtender/issues/75)) ([c568f92](https://github.com/moneymikeMD/switchtender/commit/c568f926f7b93dacb178a716c26c2d5fe3de2f09))
* export findFork and approachPoint from the package entry (CMB-130) ([#76](https://github.com/moneymikeMD/switchtender/issues/76)) ([926dffa](https://github.com/moneymikeMD/switchtender/commit/926dffad524aafab5a1eb69eff4fef94954bedab))
* findFork and approachPoint locate the fork and the wake-up point (CMB-130) ([#74](https://github.com/moneymikeMD/switchtender/issues/74)) ([1ad8c7c](https://github.com/moneymikeMD/switchtender/commit/1ad8c7c2f686ce2f4b04f2c221117f73f34f0683))
* runVerdict accepts service-level keys via opts.keys (CMB-124) ([#73](https://github.com/moneymikeMD/switchtender/issues/73)) ([f8e3e81](https://github.com/moneymikeMD/switchtender/commit/f8e3e81b0493cedf6b4214f71b9f386b8c463cc6))
* runVerdict returns an attributions list of the sources consulted (CMB-133) ([#79](https://github.com/moneymikeMD/switchtender/issues/79)) ([24aeba7](https://github.com/moneymikeMD/switchtender/commit/24aeba78b6d8e52e389bd6b355dca0004f01f3b5))
* runVerdict sends the derived row to opts.sink (CMB-128) ([#78](https://github.com/moneymikeMD/switchtender/issues/78)) ([4911cb4](https://github.com/moneymikeMD/switchtender/commit/4911cb49b5f16e0c56c15b4683b0e3882ad538ca))
* shadow-score track-work notices with the decision model, logged beside the flat penalty (CMB-159) ([#80](https://github.com/moneymikeMD/switchtender/issues/80)) ([dc10b40](https://github.com/moneymikeMD/switchtender/commit/dc10b40e3cf04335baf1f762416ce4dd44a3f038))
* track the evening ride from the Waterfront fence (CMB-161) ([#71](https://github.com/moneymikeMD/switchtender/issues/71)) ([28bbcfe](https://github.com/moneymikeMD/switchtender/commit/28bbcfeca1aeb6805da19fa04a731867a2de6b3d))

## [1.10.0](https://github.com/moneymikeMD/switchtender/compare/v1.9.0...v1.10.0) (2026-11-05)


### Features

* publish pushes through the ntfy relay and log ntfy's error code (CMB-160) ([#68](https://github.com/moneymikeMD/switchtender/issues/68)) ([a00e3f3](https://github.com/moneymikeMD/switchtender/commit/a00e3f3fc286e4b07bb94f89644c9c39f245961c))


### Bug Fixes

* read the ntfy relay key from the relay_key 1Password field (CMB-160) ([#70](https://github.com/moneymikeMD/switchtender/issues/70)) ([c0d0da8](https://github.com/moneymikeMD/switchtender/commit/c0d0da8abf36dc83c20ab75eb5692ed3d683cc54))

## [1.9.0](https://github.com/moneymikeMD/switchtender/compare/v1.8.0...v1.9.0) (2026-10-21)


### Features

* phone macros that start the morning ride and buzz on ride alerts (CMB-154) ([#67](https://github.com/moneymikeMD/switchtender/issues/67)) ([8fd5f22](https://github.com/moneymikeMD/switchtender/commit/8fd5f22fb7d483c9e4c7d90207db903f803b0312))


### Bug Fixes

* lock the ride from fixes that move, not from the phone's reported speed ([#65](https://github.com/moneymikeMD/switchtender/issues/65)) ([1cdc000](https://github.com/moneymikeMD/switchtender/commit/1cdc000e699645ca9b0810f182767f76f65d71dd))

## [1.8.0](https://github.com/moneymikeMD/switchtender/compare/v1.7.0...v1.8.0) (2026-10-21)


### Features

* deploy the ride tracker Job with its bucket, topic and grants (CMB-153) ([#63](https://github.com/moneymikeMD/switchtender/issues/63)) ([e22100b](https://github.com/moneymikeMD/switchtender/commit/e22100b3788d3cbacf7e2004162f59890dad94d4))

## [1.7.0](https://github.com/moneymikeMD/switchtender/compare/v1.6.0...v1.7.0) (2026-10-21)


### Features

* run a morning ride end to end in a Cloud Run Job (CMB-152) ([#61](https://github.com/moneymikeMD/switchtender/issues/61)) ([3939fd5](https://github.com/moneymikeMD/switchtender/commit/3939fd51be39a668dae51033ce43617c36e7a609))

## [1.6.0](https://github.com/moneymikeMD/switchtender/compare/v1.5.0...v1.6.0) (2026-10-21)


### Features

* start, feed and cancel a ride over HTTP (CMB-151) ([#58](https://github.com/moneymikeMD/switchtender/issues/58)) ([4a05160](https://github.com/moneymikeMD/switchtender/commit/4a05160a227340ed2b1ac7cae1f83f551e70a70a))
* track the owner's train in WMATA train positions (CMB-150) ([#59](https://github.com/moneymikeMD/switchtender/issues/59)) ([78169bb](https://github.com/moneymikeMD/switchtender/commit/78169bbfad0f1e5567b5256fcb74f131426534db))

## [1.5.0](https://github.com/moneymikeMD/switchtender/compare/v1.4.0...v1.5.0) (2026-10-01)


### Features

* measure the trip home and sample it hourly on weekday evenings (CMB-82) ([2714c5f](https://github.com/moneymikeMD/switchtender/commit/2714c5f8b464ec4d8829edf25c85fdd9f3a99944))
* measure the trip home and sample it hourly on weekday evenings (CMB-82) ([f51046c](https://github.com/moneymikeMD/switchtender/commit/f51046c918db72b67a39dd87e28cf59f2b68f048))
* push the verdict at 7:30 on office days, every time, from home (CMB-83) ([fd2f92b](https://github.com/moneymikeMD/switchtender/commit/fd2f92bfca407c6f0c0e747cf0279f16f2d050de))
* push the verdict at 7:30 on office days, every time, from home (CMB-83) ([4f9e913](https://github.com/moneymikeMD/switchtender/commit/4f9e91310cd045792a4927c0f0d562c1fd70969c))
* sample the verdict hourly on weekday mornings, tagged as poll (CMB-81) ([0582f80](https://github.com/moneymikeMD/switchtender/commit/0582f80812cb423a28d71706bc5fe1aa0971b173))
* sample the verdict hourly on weekday mornings, tagged as poll (CMB-81) ([3fcec09](https://github.com/moneymikeMD/switchtender/commit/3fcec0977837ca58389237bdcff9701ccde4db07))

## [1.4.0](https://github.com/moneymikeMD/switchtender/compare/v1.3.1...v1.4.0) (2026-09-26)


### Features

* define the arrivals BigQuery table beside verdicts (CMB-41) ([dd8939b](https://github.com/moneymikeMD/switchtender/commit/dd8939b0c610e585151890dd8a59ba3a58c7425e))
* define the arrivals BigQuery table beside verdicts (CMB-41) ([7257988](https://github.com/moneymikeMD/switchtender/commit/72579880cfe47ac903859bd90ac4b5c370017177))
* take the service url from config.toml, never from the repo ([0607728](https://github.com/moneymikeMD/switchtender/commit/0607728bd1721f4bd4b65e5b317d9a0403df1b2a))
* take the service url from config.toml, never from the repo ([099d222](https://github.com/moneymikeMD/switchtender/commit/099d222b1a115d075f04ab225a7927dbc84e50f1))

## [1.3.1](https://github.com/moneymikeMD/switchtender/compare/v1.3.0...v1.3.1) (2026-09-24)


### Bug Fixes

* pace Ticketmaster lookups and record 429 rate-limit headers (CMB-42) ([0dd00ac](https://github.com/moneymikeMD/switchtender/commit/0dd00acfe75d83ebec458ad62ecbec98bd175cc0))
* pace Ticketmaster lookups and record 429 rate-limit headers (CMB-42) ([c9fd6b6](https://github.com/moneymikeMD/switchtender/commit/c9fd6b6011e67a86090cf58d2e701d3cc4c08629))

## [1.3.0](https://github.com/moneymikeMD/switchtender/compare/v1.2.0...v1.3.0) (2026-09-23)


### Features

* record actual arrivals from a phone geofence (CMB-41) ([#22](https://github.com/moneymikeMD/switchtender/issues/22)) ([6c7fb44](https://github.com/moneymikeMD/switchtender/commit/6c7fb443dd7f1ed2caa3c39f1086323052841667))
* record which option was actually taken with an arrival (CMB-41) ([#23](https://github.com/moneymikeMD/switchtender/issues/23)) ([0d45dbf](https://github.com/moneymikeMD/switchtender/commit/0d45dbfb0bbe59e884ce2f05521399d00865b58e))


### Bug Fixes

* pin work-order ^1.6.0 and work-order-jira ^0.5.1 ([9b9c99c](https://github.com/moneymikeMD/switchtender/commit/9b9c99cc7179da899c015ebb7dd65388a5589c34))
* pin work-order ^1.6.0 and work-order-jira ^0.5.1 ([ec9288e](https://github.com/moneymikeMD/switchtender/commit/ec9288e47901211661798031929b90cf245886e8))
* skip Ticketmaster venue lookups with a configured id (CMB-42) ([#20](https://github.com/moneymikeMD/switchtender/issues/20)) ([3b17f39](https://github.com/moneymikeMD/switchtender/commit/3b17f39a1769e0a23cc7320faad3a96dd55eaae8))
* use --update-headers when updating the scheduler job ([#24](https://github.com/moneymikeMD/switchtender/issues/24)) ([9f0d085](https://github.com/moneymikeMD/switchtender/commit/9f0d085f261c83031e3ae30e5f1b89e115325764))

## [1.2.0](https://github.com/moneymikeMD/switchtender/compare/v1.1.0...v1.2.0) (2026-09-20)


### Features

* adopt work-order for ticket tooling, not night-watchman (CMB-7) ([#16](https://github.com/moneymikeMD/switchtender/issues/16)) ([4ee5223](https://github.com/moneymikeMD/switchtender/commit/4ee52236e1f1c5ea93064f324bba7b984d66d206))

## [1.1.0](https://github.com/moneymikeMD/switchtender/compare/v1.0.0...v1.1.0) (2026-09-18)


### Features

* push a verdict alert to ntfy.sh on a weekday-morning flip (CMB-37) ([#7](https://github.com/moneymikeMD/switchtender/issues/7)) ([63a8da7](https://github.com/moneymikeMD/switchtender/commit/63a8da7e29fe8c93eaa86f05bf6c96a5da5523fc))
* score WMATA rail alerts as a signal (CMB-35) ([#9](https://github.com/moneymikeMD/switchtender/issues/9)) ([adf0cfc](https://github.com/moneymikeMD/switchtender/commit/adf0cfc7698076f9e93c0fa1c62af8d76b4cd8cf))


### Bug Fixes

* exclude release-please's own outputs from Prettier ([#11](https://github.com/moneymikeMD/switchtender/issues/11)) ([96b55f4](https://github.com/moneymikeMD/switchtender/commit/96b55f411de51cb04dd0d98232d03e21be11f264))
* exempt Dependabot PRs from the body-length check ([05618e7](https://github.com/moneymikeMD/switchtender/commit/05618e7991ade6b64fd9cfc3efc085ecda66085b))
* exempt release-please's own PRs from the body-length check ([#12](https://github.com/moneymikeMD/switchtender/issues/12)) ([cf9fc29](https://github.com/moneymikeMD/switchtender/commit/cf9fc292137dbcf66c1ec9849bfde75e4e46c5a9))
