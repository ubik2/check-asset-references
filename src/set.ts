function setSubtract<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set<T>([...a].filter((item) => !b.has(item)));
}

function setUnion<T>(a: Set<T>, b: Set<T>): Set<T> {
  const tmp = new Set<T>(a);
  [...b].forEach((item) => tmp.add(item));
  return tmp;
}

function setIntersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set<T>([...a].filter((item) => b.has(item)));
}

export { setSubtract, setUnion, setIntersection };
