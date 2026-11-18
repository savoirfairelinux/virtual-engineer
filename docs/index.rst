Virtual Engineer Documentation
==============================

Virtual Engineer is a self-hosted orchestrator for coding and code-review
agents. It runs each agent cycle in an ephemeral OpenShell sandbox while
keeping Git and review credentials on the host.

`Source code and quick start <https://github.com/savoirfairelinux/virtual-engineer>`_ |
`Contributing <https://github.com/savoirfairelinux/virtual-engineer/blob/main/CONTRIBUTING.md>`_ |
`Kubernetes deployment <https://github.com/savoirfairelinux/virtual-engineer/blob/main/deploy/k8s/README.md>`_

The architecture guide describes the system and its workflows. The
architecture decision record and code quality audit are preserved as
historical documents; their descriptions and findings may not reflect the
current implementation.

.. toctree::
   :maxdepth: 3
   :caption: Contents

   ARCHITECTURE
   adr/0001-openshell-agent-runtime
   CODE_QUALITY_AUDIT
