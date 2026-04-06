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
    // :id should not match slashes
    assert.doesNotMatch('/users/a/b', regex);
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

    it('decodes percent-encoded param values', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/search/:query'));

      const result = tree.lookup('/search/hello%20world', 'GET');
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.params.query, 'hello world');
    });

    it('does not match when segment count differs', () => {
      const tree = new RadixTree();
      tree.insert(makeRoute('GET', '/users/:id'));

      assert.equal(tree.lookup('/users', 'GET').success, false);
      assert.equal(tree.lookup('/users/1/extra', 'GET').success, false);
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
        assert.deepEqual(profileResult.params, {}); // no params on static match
      }

      const paramResult = tree.lookup('/users/42', 'GET');
      assert.equal(paramResult.success, true);
      if (paramResult.success) {
        assert.deepEqual(paramResult.params, { id: '42' });
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

      // trailing slash normalizes to same segments
      assert.equal(tree.lookup('/users/', 'GET').success, true);
    });
  });
});
