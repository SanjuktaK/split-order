const storage = {
  get(key, def) {
    return new Promise((resolve) => chrome.storage.sync.get([key], (r) => resolve(r[key] ?? def)));
  },
  set(key, val) {
    return new Promise((resolve) => chrome.storage.sync.set({ [key]: val }, () => resolve()));
  }
};

const list = document.getElementById('roommate-list');
const input = document.getElementById('roommate-input');
const addBtn = document.getElementById('add-roommate');

async function render() {
  const roommates = await storage.get('roommates', []);
  list.innerHTML = '';
  roommates.forEach((name, idx) => {
    const li = document.createElement('li');
    li.textContent = name;
    const rm = document.createElement('button');
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      const next = roommates.filter((_, i) => i !== idx);
      await storage.set('roommates', next);
      render();
    });
    li.appendChild(rm);
    list.appendChild(li);
  });
}

addBtn.addEventListener('click', async () => {
  const name = (input.value || '').trim();
  if (!name) return;
  const roommates = await storage.get('roommates', []);
  if (!roommates.includes(name)) {
    roommates.push(name);
    await storage.set('roommates', roommates);
    input.value = '';
    render();
  }
});

render();

