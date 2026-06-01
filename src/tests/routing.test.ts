import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RadixTree, compilePath } from '../utils/routing.js';
import type { Route } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoute(method: Route['method'], pattern: string): Route {
  return { method, pattern, handlers: [] };
}

// ── compilePath ───────────────────────────────────────────────────────────────

describe('compilePath', () => {
  it('compiles a static path to an exact-match regex', () => {
    const { regex, paramNames } = compilePath('/users');
    assert.equal(paramNames.length, 0);
    assert.match('/users', regex);
    assert.doesNotMatch('/users/extra', regex);
  });

  it('extracts a single named param', () => {
    const { regex, paramNames } = compilePath('/users/:id');
    assert.deepEqual(paramNames, ['id']);
    assert.match('/users/42', regex);
    assert.doesNotMatch('/users', regex);
  });

  it('extracts multiple named params', () => {
    const { regex, paramNames } = compilePath('/users/:userId/posts/:postId');
    assert.deepEqual(paramNames, ['userId', 'postId']);
    assert.match('/users/1/posts/99', regex);
  });

  it('compiles a prefix path with isPrefix=true', () => {
    const { regex } = compilePath('/api', true);
    assert.match('/api', regex);
    assert.match('/api/users', regex);
    assert.doesNotMatch('/api-v2', regex);
  });

  it('handles wildcard segment', () => {
    const { regex } = compilePath('/files/*');
    assert.match('/files/a/b/c', regex);
  });

  it('does not match across segment boundaries for params', () => {
    const { regex } = compilePath('/users/:id');
    assert.doesNotMatch('/users/a/b', regex);
  });

  it('isPrefix=true matches the prefix exactly without trailing slash', () => {
    // /api should match /api itself (not just /api/*)
    const { regex } = compilePath('/api', true);
    assert.match('/api', regex);
  });

  it('isPrefix=true does not match a prefix that is a substring of a longer segment', () => {
    const { regex } = compilePath('/api', true);
    assert.doesNotMatch('/apiv2', regex);
    assert.doesNotMatch('/apiusers', regex);
  });

  it('static path does not match a subpath', () => {
    const { regex } = compilePath('/users');
    assert.doesNotMatch('/users/123', regex);
    assert.doesNotMatch('/userssuffix', regex);
  });
});

// ── RadixTree ─────────────────────────────────────────────────────────────────

describe('RadixTree', () => {
  describe('insert + lookup: static routes', () => {
    it('matches an exact static route', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/health'));

      const result = tree.lookup('/health', 'GET');
      assert.equal(result.success, true);
    });

    it('returns 404 for an unregistered path', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/health'));

      const result = tree.lookup('/missing', 'GET');
      assert.equal(result.success, false);
      assert.equal(result.code, 404);
    });

    it('returns 405 when path exists but method is not registered', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users'));

      const result = tree.lookup('/users', 'POST');
      assert.equal(result.success, false);
      assert.equal(result.code, 405);
    });

    it('throws on duplicate method+pattern registration', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users'));
      assert.throws(
        () => tree.insert(makeRoute('GET', '/users')),
        /already registered/,
      );
    });

    it('allows same path with different methods', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users'));
      tree.insert(makeRoute('POST', '/users'));

      assert.equal(tree.lookup('/users', 'GET').success, true);
      assert.equal(tree.lookup('/users', 'POST').success, true);
    });

    it('matches deeply nested static path', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/api/v1/users/profile'));

      assert.equal(tree.lookup('/api/v1/users/profile', 'GET').success, true);
      assert.equal(tree.lookup('/api/v1/users', 'GET').success, false);
      assert.equal(tree.lookup('/api/v1', 'GET').success, false);
    });
  });

  describe('lookup: param routes', () => {
    it('extracts a single param', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:id'));

      const result = tree.lookup('/users/42', 'GET');
      assert.equal(result.success, true);
      if (result.success) assert.deepEqual(result.params, { id: '42' });
    });

    it('extracts multiple params', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:userId/posts/:postId'));

      const result = tree.lookup('/users/1/posts/99', 'GET');
      assert.equal(result.success, true);
      if (result.success) {
        assert.deepEqual(result.params, { userId: '1', postId: '99' });
      }
    });

    it('extracts three params (deep nested)', () => {
      const tree = new RadixTree();
      tree.insert(
        makeRoute('GET', '/orgs/:orgId/repos/:repoId/issues/:issueId'),
      );

      const result = tree.lookup('/orgs/acme/repos/backend/issues/99', 'GET');
      assert.equal(result.success, true);
      if (result.success) {
        assert.deepEqual(result.params, {
          orgId: 'acme',
          repoId: 'backend',
          issueId: '99',
        });
      }
    });

    it('decodes percent-encoded param values', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/search/:query'));

      const result = tree.lookup('/search/hello%20world', 'GET');
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.params.query, 'hello world');
    });

    it('leaves malformed percent-encoding raw rather than throwing', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/items/:id'));

      const result = tree.lookup('/items/bad%ZZvalue', 'GET');
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.params.id, 'bad%ZZvalue');
    });

    it('does not match when segment count differs', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:id'));

      assert.equal(tree.lookup('/users', 'GET').success, false);
      assert.equal(tree.lookup('/users/1/extra', 'GET').success, false);
    });

    it('registration order does not affect param extraction', () => {
      // Insert param route before static — priority must still favour static
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:id'));
      tree.insert(makeRoute('GET', '/users/me'));

      const meResult = tree.lookup('/users/me', 'GET');
      assert.equal(meResult.success, true);
      if (meResult.success) assert.deepEqual(meResult.params, {});

      const idResult = tree.lookup('/users/42', 'GET');
      assert.equal(idResult.success, true);
      if (idResult.success) assert.deepEqual(idResult.params, { id: '42' });
    });
  });

  describe('lookup: static takes priority over param', () => {
    it('prefers static /users/profile over /users/:id', () => {
      const tree = new RadixTree();
      const profileRoute = makeRoute('GET', '/users/profile');
      const paramRoute = makeRoute('GET', '/users/:id');

      tree.insert(profileRoute);
      tree.insert(paramRoute);

      const profileResult = tree.lookup('/users/profile', 'GET');
      assert.equal(profileResult.success, true);
      if (profileResult.success) {
        assert.equal(profileResult.route, profileRoute);
        assert.deepEqual(profileResult.params, {});
      }

      const paramResult = tree.lookup('/users/42', 'GET');
      assert.equal(paramResult.success, true);
      if (paramResult.success) {
        assert.deepEqual(paramResult.params, { id: '42' });
      }
    });

    it('falls back to param when static child does not lead to a route', () => {
      // /users/profile/x has no route — should backtrack to /users/:id/x
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:id/settings'));

      // 'profile' is not a registered static child — must use :id
      const result = tree.lookup('/users/profile/settings', 'GET');
      assert.equal(result.success, true);
      if (result.success) {
        assert.deepEqual(result.params, { id: 'profile' });
      }
    });
  });

  describe('lookup: wildcard', () => {
    it('matches remaining segments into params["*"]', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/files/*'));

      const result = tree.lookup('/files/a/b/c', 'GET');
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.params['*'], 'a/b/c');
    });

    it('matches a single remaining segment', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/files/*'));

      const result = tree.lookup('/files/readme.md', 'GET');
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.params['*'], 'readme.md');
    });
  });

  describe('collectAllowedMethods', () => {
    it('returns all registered methods for a path', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users'));
      tree.insert(makeRoute('POST', '/users'));
      tree.insert(makeRoute('DELETE', '/users'));

      const allowed = tree.collectAllowedMethods('/users');
      assert.deepEqual(allowed, new Set(['GET', 'POST', 'DELETE']));
    });

    it('returns empty set for unregistered path', () => {
      const tree = new RadixTree();
      const allowed = tree.collectAllowedMethods('/nothing');
      assert.equal(allowed.size, 0);
    });

    it('works for param paths', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:id'));
      tree.insert(makeRoute('PATCH', '/users/:id'));

      const allowed = tree.collectAllowedMethods('/users/42');
      assert.deepEqual(allowed, new Set(['GET', 'PATCH']));
    });
  });

  describe('edge cases', () => {
    it('handles root path /', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/'));

      assert.equal(tree.lookup('/', 'GET').success, true);
    });

    it('handles trailing slash as same as no slash', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users'));

      assert.equal(tree.lookup('/users/', 'GET').success, true);
    });

    it('does not confuse sibling static segments', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users'));
      tree.insert(makeRoute('GET', '/posts'));

      assert.equal(tree.lookup('/users', 'GET').success, true);
      assert.equal(tree.lookup('/posts', 'GET').success, true);
      assert.equal(tree.lookup('/comments', 'GET').success, false);
    });

    it('handles many methods on the same param route', () => {
      const tree = new RadixTree();
      const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
      for (const m of methods) tree.insert(makeRoute(m, '/items/:id'));

      for (const m of methods) {
        const r = tree.lookup('/items/1', m);
        assert.equal(r.success, true, `Expected success for ${m}`);
      }
    });
  });
});
