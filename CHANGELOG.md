# Changelog

## [0.4.0](https://github.com/savoirfairelinux/virtual-engineer/compare/v0.3.0...v0.4.0) (2026-11-06)


### Features

* **admin:** match task queue search against project name ([e147d54](https://github.com/savoirfairelinux/virtual-engineer/commit/e147d548e0951ebdefaf01012404875d8a942335))
* **admin:** match task queue search against project name ([1c9a706](https://github.com/savoirfairelinux/virtual-engineer/commit/1c9a70635b8cb6527fba9c7dc0707969e2d151ce))


### Bug Fixes

* **admin:** bound copy scan and ambiguous resume ([7c7fbc3](https://github.com/savoirfairelinux/virtual-engineer/commit/7c7fbc31b7a29a0082d5b565adf3ddffb073fbc1))
* **admin:** count mirrored log events once ([180c9ea](https://github.com/savoirfairelinux/virtual-engineer/commit/180c9ea1ada19e56667c0a3a41e121bd622ad682))
* **admin:** keep stream status out of log window ([4163b8e](https://github.com/savoirfairelinux/virtual-engineer/commit/4163b8effd477493cd6ed3bd9c2f41e1c868c0f5))
* **admin:** resume log streams only from buffer ([fcf002a](https://github.com/savoirfairelinux/virtual-engineer/commit/fcf002aa27d72a67959f9d21b9b836f181981aaf))
* **gerrit:** prevent SSH option injection ([31cfd50](https://github.com/savoirfairelinux/virtual-engineer/commit/31cfd50b0381ebfde4e9fc4628e4b8b58eda2768))
* **gerrit:** prevent SSH option injection ([7af44e5](https://github.com/savoirfairelinux/virtual-engineer/commit/7af44e591a991c3c08582a2ed1cd189a5cc4dd1e))
* **orchestrator:** dispatch events to every task ([6d61540](https://github.com/savoirfairelinux/virtual-engineer/commit/6d61540880cfe20c08e9ec3146af1b40080d7632))
* **orchestrator:** handle missing GitHub tickets ([3ba5a98](https://github.com/savoirfairelinux/virtual-engineer/commit/3ba5a9846242449b36a6e3aec7bc57a87e37cd21))
* **orchestrator:** poll native hosted reviews ([9a25cc2](https://github.com/savoirfairelinux/virtual-engineer/commit/9a25cc2468e481c888cc54bbbd6aa9fec8c750f2))
* **orchestrator:** reuse Change-Ids per target ([c561ed7](https://github.com/savoirfairelinux/virtual-engineer/commit/c561ed793fc4fd6a7b18b7f6c962787bd71aa680))
* **orchestrator:** scope hosted webhooks by repo ([51c26eb](https://github.com/savoirfairelinux/virtual-engineer/commit/51c26eb7cfc9b8f806a5f53a6d56df394d18a11a))
* **orchestrator:** update all review watchers ([8f14002](https://github.com/savoirfairelinux/virtual-engineer/commit/8f14002a0e090ddfaba76ee2b65e0e16c2d0e458))
* **state:** keep recorded rows over legacy ids ([8ef21bb](https://github.com/savoirfairelinux/virtual-engineer/commit/8ef21bbb6cbfdfff773bdd3c8b890ac27f2d2daf))
* **vcs:** harden hosted identity repair lookups ([8585804](https://github.com/savoirfairelinux/virtual-engineer/commit/85858049e531f00c8b26a2fca4a8af1b18a27ebd))
* **vcs:** preserve native PR and MR identities ([285654e](https://github.com/savoirfairelinux/virtual-engineer/commit/285654e9e5b947884ed80f52a549cbd89e29b516))
* **vcs:** prove repair branch per repository ([fd972c4](https://github.com/savoirfairelinux/virtual-engineer/commit/fd972c4b67b0146f619271fafc4bdfe0692c2013))
* **workspace:** accept Unicode whitespace in HEAD ([66af644](https://github.com/savoirfairelinux/virtual-engineer/commit/66af644442c5640d57ee1da40e179152c229776b))
* **workspace:** bound HEAD reads and check access ([cefbd43](https://github.com/savoirfairelinux/virtual-engineer/commit/cefbd43c4a109bea5d84659cc8c4d276a7577928))
* **workspace:** reject shared Git metadata ([5412418](https://github.com/savoirfairelinux/virtual-engineer/commit/5412418050bd28a735b6f657b25265fa2d95e389))
* **workspace:** strip leftover linked worktrees ([80331ec](https://github.com/savoirfairelinux/virtual-engineer/commit/80331ecf60924d65fb051ed8980258417b583037))


### Performance Improvements

* **admin:** bound task log stream replay ([59fa949](https://github.com/savoirfairelinux/virtual-engineer/commit/59fa9490b8111f65202401ebe83b38020aa77558))
* **admin:** defer and bound task log replay ([aa5dc83](https://github.com/savoirfairelinux/virtual-engineer/commit/aa5dc833b68bd3879bb67db9cba1c5d9de43d1c7))
* **admin:** open task logs on demand ([cf9fdee](https://github.com/savoirfairelinux/virtual-engineer/commit/cf9fdeee684b5bd2f14b356d7ab64b3c9165f04e))

## [0.3.0](https://github.com/savoirfairelinux/virtual-engineer/compare/v0.2.0...v0.3.0) (2026-10-29)


### Features

* **admin:** add GitHub bug report form ([e5ef56a](https://github.com/savoirfairelinux/virtual-engineer/commit/e5ef56acced4ce9a9067fda9c39fef72c8555866))
* **admin:** add GitHub issue reporting link ([959673b](https://github.com/savoirfairelinux/virtual-engineer/commit/959673b0d1441a9ff5bd5b003e6c9f448f8f39ba))
* **admin:** add GitHub issue reporting link ([e715388](https://github.com/savoirfairelinux/virtual-engineer/commit/e715388d499d152b311c2e6d92e8170c542d8d17))
* **admin:** add scoped analytics CSV exports ([26142d0](https://github.com/savoirfairelinux/virtual-engineer/commit/26142d00b06c1e08e2e7087f61059c5ad96320e2))
* **admin:** choose branches for review projects ([e787ae8](https://github.com/savoirfairelinux/virtual-engineer/commit/e787ae8c1868417210618d458e90c5ca00a36e55))
* **admin:** export scoped analytics as CSV ([272da55](https://github.com/savoirfairelinux/virtual-engineer/commit/272da559f301b5c13930de6bd9f993f4189cbe70))
* **admin:** keep directory sessions in step with LDAP ([2df61e7](https://github.com/savoirfairelinux/virtual-engineer/commit/2df61e7106b9a70bcd2fc1e8cfcda1b41410091d))
* **admin:** manage LDAP authentication sources ([803fc3e](https://github.com/savoirfairelinux/virtual-engineer/commit/803fc3ea501244c846f1b30491c0d7804fc261e8))
* **admin:** provision directory users and map their groups ([0f3df40](https://github.com/savoirfairelinux/virtual-engineer/commit/0f3df401c3d9322cdac5dbed558dabec9e935e0a))
* **admin:** sign in linked users through LDAP ([bbadb39](https://github.com/savoirfairelinux/virtual-engineer/commit/bbadb3972889ef237ca0e8b4de75aa95f3fd1692))
* **dashboard:** add Authentication config page ([63eca76](https://github.com/savoirfairelinux/virtual-engineer/commit/63eca760d49bb6135389bfc5370e6794aee2e3fa))
* **dashboard:** centralize CSV exports ([c7ec02c](https://github.com/savoirfairelinux/virtual-engineer/commit/c7ec02c9d37d35cc2da3ed98ff04f4f576c4dbd3))
* **dashboard:** combine task queue filters ([a11128b](https://github.com/savoirfairelinux/virtual-engineer/commit/a11128bb1d07062e350383da5f4cc8e98054d772))
* **dashboard:** configure directory session limits ([ea31378](https://github.com/savoirfairelinux/virtual-engineer/commit/ea31378a2e5fc70736010092f84f36e909a69a9b))
* **dashboard:** configure provisioning and group mappings ([17bf25b](https://github.com/savoirfairelinux/virtual-engineer/commit/17bf25b4e1e324011ccf20a81f08418a87e894d5))
* **dashboard:** manage directory users ([fc2087a](https://github.com/savoirfairelinux/virtual-engineer/commit/fc2087a1bfe7d3529d5ebc6caf4bb87a4e5e8633))
* **db:** add auth_sources table ([a6bd257](https://github.com/savoirfairelinux/virtual-engineer/commit/a6bd257e1d78c7c0d1d4a09d464ea0745e999bb7))
* **db:** add directory group mappings and provisioning settings ([cf42e57](https://github.com/savoirfairelinux/virtual-engineer/commit/cf42e57d7010773d09cd48ac040e7efc1fa25912))
* **db:** add session revalidation columns ([07ff838](https://github.com/savoirfairelinux/virtual-engineer/commit/07ff838c9914311c39c7389e33324180fd2227f0))
* **db:** add user_identities table ([955dfd7](https://github.com/savoirfairelinux/virtual-engineer/commit/955dfd7b01f2f6872792bc24f3318a6b15e63dbd))
* **state:** expose when tasks entered their current state ([a63c8a4](https://github.com/savoirfairelinux/virtual-engineer/commit/a63c8a43e87cf7da6f3b6f13c482e8bed61936fb))


### Bug Fixes

* **admin:** address General View review feedback ([19e6bd6](https://github.com/savoirfairelinux/virtual-engineer/commit/19e6bd6f7f6e59658d3eb212dcac95584ab36a61))
* **admin:** align overview, CSV export and task filters on status categories ([67efe8b](https://github.com/savoirfairelinux/virtual-engineer/commit/67efe8b8e37dbfb628e427ca36b5b3d13baf0a21))
* **admin:** keep task queue status chips within their bounds ([9b2de67](https://github.com/savoirfairelinux/virtual-engineer/commit/9b2de67b61c0ff02d9fd1ba123670768100b4ec6))
* **admin:** make General View counters and status categories consistent ([695ad7b](https://github.com/savoirfairelinux/virtual-engineer/commit/695ad7b7e966fb402b0fbffcf2a2dd3d629092cd))
* **admin:** make General View outcome counters consistent ([6c66ae3](https://github.com/savoirfairelinux/virtual-engineer/commit/6c66ae3f52d7ddf0ed492e1554fff9dba5576f72))
* **admin:** reject prefix-only review branches ([10cf0a5](https://github.com/savoirfairelinux/virtual-engineer/commit/10cf0a5f8b16f83082c7a6c68f1219f95ef02507))
* **admin:** surface integration activation failures in provider health ([1ad4a02](https://github.com/savoirfairelinux/virtual-engineer/commit/1ad4a02c4ba718443c49363ed3885b33c426fbcc))
* **agent:** explain context-window overflows ([73e4076](https://github.com/savoirfairelinux/virtual-engineer/commit/73e4076ae3b0a133074443b5b0997cbbeab771f6))
* **agent:** fall back to Copilot auto ([747ed4b](https://github.com/savoirfairelinux/virtual-engineer/commit/747ed4b2c88834813070715eae7af46b31cf2938))
* **agent:** keep fallback on disconnect errors ([cba77c9](https://github.com/savoirfairelinux/virtual-engineer/commit/cba77c92830eaf077ee924ad04b039e808d66db1))
* **dashboard:** add Virtual Engineer favicon ([f732962](https://github.com/savoirfairelinux/virtual-engineer/commit/f7329620e95f238e85a21636d90525f72884f305))
* **deps:** align Zod imports with the native Zod 4 migration from main ([0033d55](https://github.com/savoirfairelinux/virtual-engineer/commit/0033d552a1974c1913a802e8880d8361581d11a3))
* **deps:** bump @hono/node-server override to 2.1.5 in agent-worker ([4fb52e4](https://github.com/savoirfairelinux/virtual-engineer/commit/4fb52e4a43e14645a064b80b83137d802a0fc73d))
* **deps:** bump hono to patch audit advisory ([28bafa4](https://github.com/savoirfairelinux/virtual-engineer/commit/28bafa49bf5306ab6bff4c3e6b30af1f1078c093))
* **deps:** migrate to patched Zod 4 ([5ae316d](https://github.com/savoirfairelinux/virtual-engineer/commit/5ae316d4893a0a89e8c387f991ef724de79ccf87))
* **deps:** upgrade zod to 4.6.7 to resolve audit advisory ([1bd2015](https://github.com/savoirfairelinux/virtual-engineer/commit/1bd201553822df19f26d644faf0a51955db6178b))
* **gerrit:** preserve complete merge reviews ([81b9b14](https://github.com/savoirfairelinux/virtual-engineer/commit/81b9b14781bbc5730bfa96337023a5004ae7e390))
* **gerrit:** review changes on every branch ([8ac3d80](https://github.com/savoirfairelinux/virtual-engineer/commit/8ac3d80e8f676a1c8992a47c960e2d68aa56ff1d))
* **gerrit:** review merges against the auto-merge ([f204e3a](https://github.com/savoirfairelinux/virtual-engineer/commit/f204e3acb08b3e0c20d7aee36392bf725bcbde8d))
* **gerrit:** route lifecycle ids independently ([4bd60cd](https://github.com/savoirfairelinux/virtual-engineer/commit/4bd60cd0119aa697005291630b9e91d391daafe7))
* **gerrit:** trigger reviews by change number ([8216747](https://github.com/savoirfairelinux/virtual-engineer/commit/82167479a7c2bbe02754ecab79ba4878a6576707))
* **github:** tolerate oversized generated files in review diffs ([1c6160d](https://github.com/savoirfairelinux/virtual-engineer/commit/1c6160daaff02a78feea1711886d4a16eb300975))
* **orchestrator:** include UI test helpers ([afeb05f](https://github.com/savoirfairelinux/virtual-engineer/commit/afeb05f7e05dce6aa0ddefb36da7565ff02f9ca6))
* **polling-loop:** key status polls by task ([38afb15](https://github.com/savoirfairelinux/virtual-engineer/commit/38afb15210a49dded5eefe055c7096ba97575796))
* **review:** attach oversized diffs instead of inlining them ([8f8001b](https://github.com/savoirfairelinux/virtual-engineer/commit/8f8001bdcdb5fb91b04b76eb86c4272b38a78e01))
* **review:** avoid duplicate Gerrit review on automatic assignment ([330d222](https://github.com/savoirfairelinux/virtual-engineer/commit/330d222e142611589efeeb96eba189c8be11f9d9))
* **review:** deduplicate Gerrit reviewer-added events from self-assignment ([f60b906](https://github.com/savoirfairelinux/virtual-engineer/commit/f60b9065b72c7c2bdbb3d325b3a3e82448034aa3))
* **review:** enforce review diff budgets ([3257a6b](https://github.com/savoirfairelinux/virtual-engineer/commit/3257a6b6d7bb10458a7c57b66dbb0ad1b2cb7a4d))
* **scripts:** extend Docker-local Keycloak readiness wait ([3c9601f](https://github.com/savoirfairelinux/virtual-engineer/commit/3c9601f671bc6005c5a51940d78a18a33fd54e90))

## [0.2.0](https://github.com/savoirfairelinux/virtual-engineer/compare/v0.1.0...v0.2.0) (2026-10-13)


### Features

* **admin:** report running build version ([d3a82b7](https://github.com/savoirfairelinux/virtual-engineer/commit/d3a82b762ae6f34e0e97b9c3238aec928fe9343d))


### Bug Fixes

* **orchestrator:** refresh build revision ([0d09bdd](https://github.com/savoirfairelinux/virtual-engineer/commit/0d09bdd2933b8124c5b55fffe63f788d465aea8d))
