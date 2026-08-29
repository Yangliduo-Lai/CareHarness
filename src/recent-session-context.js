export const RECENT_SESSION_WINDOW = 3;

/**
 * Keep the newest complete visible Sessions as an unranked short-term context.
 * Their Memory Nodes are removed from the long-term retrieval pool, so Answer
 * never receives the same fact once as a transcript and again as a selected
 * historical node.
 */
export function partitionRecentSessionContext({
  visible_episode_ids = [],
  observations = [],
  memory_nodes = [],
  memory_edges = [],
  window = RECENT_SESSION_WINDOW,
} = {}) {
  const visibleOrder = unique(visible_episode_ids.map(String).filter(Boolean));
  const observationByEpisode = new Map(
    observations
      .filter(item => item?.episode_id && visibleOrder.includes(String(item.episode_id)))
      .map(item => [String(item.episode_id), item]),
  );
  const availableOrder = visibleOrder.filter(id => observationByEpisode.has(id));
  const recentIds = new Set(availableOrder.slice(-positiveWindow(window)));
  const recentSessions = availableOrder
    .filter(id => recentIds.has(id))
    .map(id => {
      const observation = observationByEpisode.get(id);
      return {
        episode_id: id,
        event_time: observation.event_time || null,
        transcript: String(observation.raw_text || ''),
      };
    });
  const historicalNodes = memory_nodes.filter(node => !recentIds.has(String(node?.episode_id || '')));
  const historicalIds = new Set(historicalNodes.map(node => String(node.memory_id)));
  const historicalEdges = memory_edges.filter(edge =>
    historicalIds.has(String(edge?.from_memory_id || ''))
    && historicalIds.has(String(edge?.to_memory_id || ''))
    && (edge?.support_memory_ids || []).every(id => historicalIds.has(String(id))),
  );
  return {
    recent_sessions: recentSessions,
    recent_episode_ids: [...recentIds],
    historical_memory_nodes: historicalNodes,
    historical_memory_edges: historicalEdges,
    policy: {
      version: 'recent-session-bypass.v1',
      window: positiveWindow(window),
      recent_sessions_are_unranked: true,
      recent_nodes_excluded_from_historical_retrieval: true,
    },
  };
}

function positiveWindow(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : RECENT_SESSION_WINDOW;
}

function unique(values) {
  return [...new Set(values)];
}
