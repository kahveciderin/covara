import { getOrCreateClient } from 'covara/client';
import { useAuth, useLiveList, usePublicEnv, useSearch, useFileUpload } from 'covara/client/react';
import { AuthForm } from './components/AuthForm';
import { createTypedClient } from './generated/api-types';
import type { PublicEnv } from './generated/api-types';
import { useState, useEffect, useRef } from 'react';

// User type for auth
interface User {
  id: string;
  email: string;
  name: string;
}

// Initialize typed client once (HMR-safe)
// Now you can use: client.resources.todos.query() for type-safe queries!
const baseClient = getOrCreateClient({
  baseUrl: location.origin,
  credentials: 'include',
  offline: true,
});

// Wrap with typed client for type-safe resource accessors
const client = createTypedClient(baseClient);

export function App() {
  const { user, isLoading, isAuthenticated, logout } = useAuth<User>();
  const { env } = usePublicEnv<PublicEnv>();

  // Set auth error handler (redirects to login on 401)
  useEffect(() => {
    baseClient.setAuthErrorHandler(logout);
  }, [logout]);

  if (isLoading) {
    return (
      <div className="container">
        <div className="card">
          <div className="content" style={{ textAlign: 'center', padding: 40 }}>
            Loading...
          </div>
          {env?.PUBLIC_VERSION && (
            <div className="version-badge">v{env.PUBLIC_VERSION}</div>
          )}
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <AuthForm onLogin={() => window.location.reload()} version={env?.PUBLIC_VERSION} />;
  }

  return <TodoApp user={user} onLogout={logout} version={env?.PUBLIC_VERSION} searchEnabled={env?.PUBLIC_OPENSEARCH_ENABLED} />;
}

function TodoApp({ user, onLogout, version, searchEnabled }: { user: User; onLogout: () => void; version?: string; searchEnabled?: boolean }) {
  const [newTodo, setNewTodo] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('#6366f1');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadingTodoId, setUploadingTodoId] = useState<string | null>(null);
  const [categoryStats, setCategoryStats] = useState<{ name: string; count: number }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch todos with relations using fluent API
  // Types are automatically inferred from .include() calls
  const {
    items: todos,
    status,
    statusLabel,
    mutate,
    hasMore,
    totalCount,
    isLoadingMore,
    loadMore,
  } = useLiveList(
    client.resources.todos
      .orderBy('position')
      .include('category', 'image', 'tags')
      .limit(5)
  );

  // File upload hook
  const { upload, isUploading, progress } = useFileUpload({
    resourcePath: '/api/files',
  });

  // Fetch categories for the dropdown using fluent API
  // Type is inferred automatically
  const { items: categories, mutate: categoryMutate } = useLiveList(
    client.resources.categories
      .orderBy('name')
      .select('id', 'name', 'color')
  );

  // Fetch category stats using the type-safe query builder
  // This demonstrates aggregations with groupBy
  useEffect(() => {
    const fetchCategoryStats = async () => {
      try {
        // Type-safe aggregation: groupBy categoryId and count
        const result = await client.resources.todos
          .query()
          .filter('categoryId=isnull=false')
          .groupBy('categoryId')
          .withCount()
          .aggregate();

        // Map category IDs to names
        const stats = result.groups
          .map(group => {
            const categoryId = (group.key as { categoryId: string })?.categoryId;
            const category = categories.find(c => c.id === categoryId);
            return {
              name: category?.name || 'Unknown',
              count: (group as { count?: number }).count || 0,
            };
          })
          .filter(s => s.count > 0)
          .sort((a, b) => b.count - a.count);

        setCategoryStats(stats);
      } catch (error) {
        console.error('Failed to fetch category stats:', error);
      }
    };

    if (categories.length > 0) {
      fetchCategoryStats();
    }
  }, [categories, todos.length]); // Refetch when todos change

  // Search functionality using the useSearch hook
  // Type is inferred from client.resources.todos
  const {
    items: searchResults,
    isSearching,
    search,
    clear: clearSearch,
  } = useSearch(client.resources.todos, { enabled: searchEnabled });

  // Update search when query changes
  useEffect(() => {
    search(searchQuery);
  }, [searchQuery, search]);

  const addTodo = () => {
    if (!newTodo.trim()) return;
    mutate.create({
      title: newTodo.trim(),
      categoryId: selectedCategoryId,
    });
    setNewTodo('');
  };

  const addCategory = () => {
    if (!newCategoryName.trim()) return;
    categoryMutate.create({
      name: newCategoryName.trim(),
      color: newCategoryColor,
    });
    setNewCategoryName('');
    setShowCategoryForm(false);
  };

  const handleImageUpload = async (todoId: string, file: File) => {
    try {
      setUploadingTodoId(todoId);
      const uploaded = await upload(file);
      mutate.update(todoId, { imageId: uploaded.id });
    } catch (error) {
      console.error('Failed to upload image:', error);
    } finally {
      setUploadingTodoId(null);
    }
  };

  const handleRemoveImage = (todoId: string) => {
    mutate.update(todoId, { imageId: null });
  };

  const completedCount = todos.filter((t) => t.completed).length;

  return (
    <div className="container">
      <div className="card">
        <div className="header">
          <h1>My Todos</h1>
          <p>Stay organized, get things done</p>
        </div>
        <div className="user-bar">
          <span>Hi, {user.name}!</span>
          <button onClick={onLogout}>Sign out</button>
        </div>
        <div className="content">
          {/* Search bar (only when OpenSearch is enabled) */}
          {searchEnabled && (
            <div className="search-section">
              <div className="search-input-row">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search todos..."
                  className="search-input"
                />
                {searchQuery && (
                  <button className="search-clear" onClick={() => { clearSearch(); setSearchQuery(''); }}>×</button>
                )}
                {isSearching && <span className="search-indicator">Searching...</span>}
              </div>
              {searchQuery.trim() !== '' && (
                <div className="search-results">
                  <div className="search-results-header">
                    <span>{searchResults.length} result{searchResults.length !== 1 ? 's' : ''} found</span>
                    <button className="btn btn-secondary btn-small" onClick={() => { clearSearch(); setSearchQuery(''); }}>Clear</button>
                  </div>
                  {searchResults.length === 0 ? (
                    <div className="empty-state">
                      <p>No todos match your search.</p>
                    </div>
                  ) : (
                    <ul className="todo-list search-results-list">
                      {searchResults.map((todo) => (
                        <li key={todo.id} className="todo-item">
                          <div
                            className={`todo-checkbox${todo.completed ? ' checked' : ''}`}
                            onClick={() => mutate.update(todo.id, { completed: !todo.completed })}
                          />
                          <div className="todo-content">
                            <span className={`todo-title${todo.completed ? ' completed' : ''}`}>
                              {todo.title}
                            </span>
                          </div>
                          <button className="todo-delete" onClick={() => mutate.delete(todo.id)}>×</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Todo input with category selector */}
          <div className="todo-input-row">
            <input
              type="text"
              value={newTodo}
              onChange={(e) => setNewTodo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTodo()}
              placeholder="What needs to be done?"
            />
            <select
              value={selectedCategoryId ?? ''}
              onChange={(e) => setSelectedCategoryId(e.target.value || null)}
              className="category-select"
            >
              <option value="">No category</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={addTodo}>Add</button>
          </div>

          {/* Category management */}
          <div className="category-section">
            {!showCategoryForm ? (
              <button
                className="btn btn-secondary btn-small"
                onClick={() => setShowCategoryForm(true)}
              >
                + New Category
              </button>
            ) : (
              <div className="category-form">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCategory()}
                  placeholder="Category name"
                  className="category-input"
                />
                <input
                  type="color"
                  value={newCategoryColor}
                  onChange={(e) => setNewCategoryColor(e.target.value)}
                  className="color-picker"
                />
                <button className="btn btn-primary btn-small" onClick={addCategory}>
                  Add
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => setShowCategoryForm(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            {categories.length > 0 && (
              <div className="category-chips">
                {categories.map((cat) => (
                  <span
                    key={cat.id}
                    className="category-chip"
                    style={{ backgroundColor: cat.color || '#6366f1' }}
                  >
                    {cat.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Hidden file input for image uploads */}
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && uploadingTodoId) {
                handleImageUpload(uploadingTodoId, file);
              }
              e.target.value = '';
            }}
          />

          {todos.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🎉</div>
              <p>No todos yet. Add one above!</p>
            </div>
          ) : (
            <ul className="todo-list">
              {todos.map((todo) => (
                <li key={todo.id} className="todo-item">
                  <div
                    className={`todo-checkbox${todo.completed ? ' checked' : ''}`}
                    onClick={() => mutate.update(todo.id, { completed: !todo.completed })}
                  />
                  <div className="todo-content">
                    <span className={`todo-title${todo.completed ? ' completed' : ''}`}>
                      {todo.title}
                    </span>
                    {(() => {
                      // Use included relation if available, otherwise look up from categories list
                      // This handles optimistic updates where the relation is cleared but categoryId is set
                      const displayCategory = todo.category ?? categories.find(c => c.id === todo.categoryId);
                      return (displayCategory || (todo.tags && todo.tags.length > 0)) && (
                        <div className="todo-meta">
                          {displayCategory && (
                            <span
                              className="todo-category"
                              style={{ backgroundColor: displayCategory.color || '#6366f1' }}
                            >
                              {displayCategory.name}
                            </span>
                          )}
                          {todo.tags && todo.tags.map((tag) => (
                          <span key={tag.id} className="todo-tag">
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    );
                    })()}
                    {/* Image display */}
                    {todo.image && (
                      <div className="todo-image-container">
                        <img
                          src={todo.image.url || `/api/files/${todo.imageId}/download`}
                          alt={todo.image.filename}
                          className="todo-image"
                        />
                        <button
                          className="todo-image-remove"
                          onClick={() => handleRemoveImage(todo.id)}
                          title="Remove image"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Image upload button */}
                  <button
                    className={`todo-image-btn${uploadingTodoId === todo.id ? ' uploading' : ''}`}
                    onClick={() => {
                      setUploadingTodoId(todo.id);
                      fileInputRef.current?.click();
                    }}
                    disabled={isUploading}
                    title={todo.image ? 'Change image' : 'Add image'}
                  >
                    {uploadingTodoId === todo.id && isUploading ? (
                      progress ? `${progress.percent}%` : '...'
                    ) : (
                      todo.image ? '📷' : '+'
                    )}
                  </button>
                  {/* Category quick-assign dropdown */}
                  <select
                    value={todo.categoryId ?? ''}
                    onChange={(e) =>
                      mutate.update(todo.id, { categoryId: e.target.value || null })
                    }
                    className="todo-category-select"
                    title="Assign category"
                  >
                    <option value="">-</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                  <button className="todo-delete" onClick={() => mutate.delete(todo.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Pagination */}
          {hasMore && (
            <div className="pagination">
              <button
                className="btn btn-secondary"
                onClick={loadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </div>
        {todos.length > 0 && (
          <div className="stats">
            <div><span>{completedCount}</span> completed</div>
            <div><span>{todos.length - completedCount}</span> remaining</div>
            {totalCount !== undefined && (
              <div><span>{todos.length}</span> of <span>{totalCount}</span> loaded</div>
            )}
          </div>
        )}
        {/* Category stats from type-safe aggregation query */}
        {categoryStats.length > 0 && (
          <div className="category-stats">
            <div className="category-stats-title">Todos by Category</div>
            <div className="category-stats-list">
              {categoryStats.map((stat, i) => (
                <div key={i} className="category-stat-item">
                  <span className="category-stat-name">{stat.name}</span>
                  <span className="category-stat-count">{stat.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="connection-status">
          <span className={`status-dot ${status === 'live' ? 'connected' : status === 'reconnecting' ? 'reconnecting' : 'disconnected'}`} />
          {statusLabel}
          {version && <span className="version-text">v{version}</span>}
        </div>
      </div>
    </div>
  );
}

export default App;
