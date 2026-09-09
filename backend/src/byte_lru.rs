use std::collections::{HashMap, VecDeque};

pub(crate) struct ByteLru<V> {
    entries: HashMap<String, (V, usize)>,
    order: VecDeque<String>,
    bytes: usize,
}

impl<V> Default for ByteLru<V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
        }
    }
}

impl<V> ByteLru<V> {
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.keys()
    }

    pub(crate) fn peek(&self, key: &str) -> Option<&V> {
        self.entries.get(key).map(|(value, _)| value)
    }

    pub(crate) fn peek_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.get_mut(key).map(|(value, _)| value)
    }

    pub(crate) fn touch(&mut self, key: &str) {
        // ponytail: O(n) over a byte-bounded cache; profile before adding an intrusive list.
        if let Some(index) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(index);
            self.order.push_back(key.to_owned());
        }
    }

    pub(crate) fn insert(&mut self, key: &str, value: V, bytes: usize, limit: usize) {
        self.remove(key);
        if limit == 0 || bytes > limit {
            return;
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.entries.insert(key.to_owned(), (value, bytes));
        self.order.push_back(key.to_owned());
        while self.bytes > limit {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, bytes)) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(bytes);
            }
        }
    }

    pub(crate) fn remove(&mut self, key: &str) {
        if let Some((_, bytes)) = self.entries.remove(key) {
            self.bytes = self.bytes.saturating_sub(bytes);
        }
        if let Some(index) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(index);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peek_does_not_promote_but_touch_does() {
        let mut cache = ByteLru::default();
        cache.insert("a", 1, 4, 8);
        cache.insert("b", 2, 4, 8);
        assert_eq!(cache.peek("a"), Some(&1));
        *cache.peek_mut("a").unwrap() = 3;
        cache.insert("c", 4, 4, 8);
        assert!(cache.peek("a").is_none());
        cache.touch("b");
        cache.touch("missing");
        cache.insert("d", 5, 4, 8);
        assert_eq!(cache.peek("b"), Some(&2));
        assert!(cache.peek("c").is_none());
        assert_eq!((cache.len(), cache.bytes()), (2, 8));
    }

    #[test]
    fn replacement_removal_and_disabled_or_oversized_entries_preserve_accounting() {
        let mut cache = ByteLru::default();
        cache.insert("a", 1, 4, 8);
        cache.insert("b", 2, 4, 8);
        cache.insert("a", 3, 6, 8);
        assert!(cache.peek("b").is_none());
        assert_eq!(cache.peek("a"), Some(&3));
        assert_eq!((cache.len(), cache.bytes()), (1, 6));
        cache.insert("a", 4, 9, 8);
        cache.insert("disabled", 5, 0, 0);
        assert_eq!((cache.len(), cache.bytes()), (0, 0));
        cache.insert("c", 6, 3, 8);
        cache.remove("c");
        cache.remove("c");
        assert_eq!((cache.len(), cache.bytes()), (0, 0));
        cache.insert("d", 7, 1, 8);
        cache.clear();
        assert_eq!((cache.len(), cache.bytes()), (0, 0));
        assert!(cache.keys().next().is_none());
    }
}
