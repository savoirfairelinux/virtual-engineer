import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import type { ApiIntegration } from "../../types.ts";
import {
  normalizeRepository,
  normalizeTicketProject,
  type RepositoryOption,
  type TicketProjectOption,
} from "./projectFormTypes.ts";

export function useTicketProjectOptions(integrationId: string, integrations: ApiIntegration[]) {
  const [ticketProjects, setTicketProjects] = useState<TicketProjectOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!integrationId) { setTicketProjects([]); setLoading(false); return; }
    const integration = integrations.find((i) => i.id === integrationId);
    const cached = integration?.discoveredResources?.ticketProjects;
    if (Array.isArray(cached) && cached.length > 0) {
      setTicketProjects(cached.map(normalizeTicketProject).filter((p): p is TicketProjectOption => p !== null));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.post(`/api/admin/integrations/${integrationId}/discover`, {})
      .then(() => api.get<{ integration: ApiIntegration }>(`/api/admin/integrations/${integrationId}`))
      .then((res) => {
        if (cancelled) return;
        const discovered = res.integration.discoveredResources?.ticketProjects ?? [];
        setTicketProjects(
          Array.isArray(discovered)
            ? discovered.map(normalizeTicketProject).filter((p): p is TicketProjectOption => p !== null)
            : []
        );
      })
      .catch(() => { if (!cancelled) setTicketProjects([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [integrationId, integrations]);

  return { ticketProjects, loading };
}

export function useRepositoryOptions(integrationId: string, integrations: ApiIntegration[]) {
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!integrationId) {
      setRepositories([]);
      setLoading(false);
      return;
    }

    const integration = integrations.find((i) => i.id === integrationId);
    const cached = integration?.discoveredResources?.repositories;
    if (Array.isArray(cached) && cached.length > 0) {
      setRepositories(cached.map((item) => normalizeRepository(item)).filter((item): item is RepositoryOption => item !== null));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api.post(`/api/admin/integrations/${integrationId}/discover`, {})
      .then(() => api.get<{ integration: ApiIntegration }>(`/api/admin/integrations/${integrationId}`))
      .then((res) => {
        if (cancelled) return;
        const discovered = res.integration.discoveredResources?.repositories ?? [];
        const normalized = Array.isArray(discovered)
          ? discovered.map((item) => normalizeRepository(item)).filter((item): item is RepositoryOption => item !== null)
          : [];
        setRepositories(normalized);
      })
      .catch(() => {
        if (!cancelled) setRepositories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [integrationId, integrations]);

  return { repositories, loading };
}

/** Lazily fetch the branches of a repository for a given integration + repoKey. */
export function useBranchOptions(integrationId: string, repoKey: string) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!integrationId || !repoKey) { setBranches([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.get<{ branches: string[] }>(`/api/admin/integrations/${integrationId}/branches?repoKey=${encodeURIComponent(repoKey)}`)
      .then((res) => { if (!cancelled) setBranches(Array.isArray(res.branches) ? res.branches : []); })
      .catch(() => { if (!cancelled) setBranches([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [integrationId, repoKey]);

  return { branches, loading };
}
