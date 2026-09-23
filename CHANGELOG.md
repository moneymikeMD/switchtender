# Changelog

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
