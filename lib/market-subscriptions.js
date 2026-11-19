export function createMarketSubscriptions(initialKeys = [], limit = 150) {
  let permanent = new Set(initialKeys);
  const scopes = new Map();
  const allKeys = () => new Set([...permanent, ...[...scopes.values()].flatMap(keys => [...keys])]);

  function update(change) {
    const before = allKeys();
    const previousPermanent = permanent;
    const previousScopes = new Map(scopes);
    change();
    const after = allKeys();
    if (after.size > limit) {
      permanent = previousPermanent;
      scopes.clear();
      for (const [scope, keys] of previousScopes) scopes.set(scope, keys);
      throw new Error(`This local app can stream up to ${limit} symbols at once.`);
    }
    return {
      added: [...after].filter(key => !before.has(key)),
      removed: [...before].filter(key => !after.has(key)),
      total: after.size
    };
  }

  return {
    keys: allKeys,
    permanentKeys: () => new Set(permanent),
    addPermanent(keys) {
      return update(() => { permanent = new Set([...permanent, ...keys]); });
    },
    replaceScope(scope, keys) {
      return update(() => {
        if (keys.length) scopes.set(scope, new Set(keys));
        else scopes.delete(scope);
      });
    },
    reset(keys) {
      permanent = new Set(keys);
      scopes.clear();
    }
  };
}
