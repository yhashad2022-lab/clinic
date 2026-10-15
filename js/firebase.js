window.CLINIC_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAIifYF9F67ZT0J_UttI8EDhBX0ZW3mNv8" , 
  authDomain: "yasseradnan.firebaseapp.com",
  projectId: "yasseradnan",
  storageBucket: "yasseradnan.firebasestorage.app",
  messagingSenderId: "205441404002",
  appId: "1:205441404002:web:885b8daa2273adb001953b"
};

(function () {
  const $ = id => document.getElementById(id);
  let db, unsubscribe = null, applyingRemote = false, syncing = false;
  let knownRecords = new Map();
  let syncQueue = Promise.resolve();
  const configured = window.CLINIC_FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
  const rootRef = () => db.collection("clinicData").doc("patients");
  const recordsRef = () => rootRef().collection("records");

  function setStatus(message) { const el = $("syncStatus"); if (el) el.textContent = message; }
  function showApp(user) {
    $("loginScreen").style.display = user ? "none" : "flex";
    $("appShell").style.display = user ? "block" : "none";
    if (user) $("userEmail").textContent = user.email || "مستخدم مسجل";
  }
  function errText(error) {
    const map = {
      "auth/invalid-credential":"البريد الإلكتروني أو كلمة المرور غير صحيحين.",
      "auth/user-not-found":"المستخدم غير موجود.",
      "auth/wrong-password":"كلمة المرور غير صحيحة.",
      "auth/too-many-requests":"محاولات كثيرة، حاول لاحقًا.",
      "auth/invalid-email":"صيغة البريد الإلكتروني غير صحيحة."
    };
    return map[error.code] || error.message || "حدث خطأ أثناء تسجيل الدخول.";
  }
  function ensureIds(patients) {
    const used = new Set();
    return patients.map((p, i) => {
      let id = String(p.u || ("patient_" + i)).replace(/[\\/#?\[\]]/g, "_");
      if (used.has(id)) id = id + "_" + i;
      used.add(id);
      return { ...p, u: id };
    });
  }
  function dataOf(p) {
    const out = { u: String(p.u), n: String(p.n || ""), c: p.c ?? "", i: Number(p.i) || 0 };
    if (p.t !== undefined && p.t !== null && p.t !== "") out.t = String(p.t);
    return out;
  }
  function same(a, b) { return JSON.stringify(dataOf(a)) === JSON.stringify(dataOf(b)); }
  async function commitOps(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = db.batch();
      ops.slice(i, i + 400).forEach(op => {
        if (op.delete) batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      await batch.commit();
    }
  }
  async function writeFullCollection(patients) {
    const clean = ensureIds(patients);
    const ops = clean.map(p => ({ ref: recordsRef().doc(p.u), data: dataOf(p) }));
    await commitOps(ops);
    knownRecords = new Map(clean.map(p => [p.u, dataOf(p)]));
    return clean;
  }
  async function syncPatients(patients) {
    if (!db || !firebase.auth().currentUser || applyingRemote || syncing) return;
    syncQueue = syncQueue.then(async () => {
      if (!db || !firebase.auth().currentUser || applyingRemote) return;
      syncing = true;
      try {
        setStatus("جاري حفظ التعديلات…");
        const clean = ensureIds(patients);
        const next = new Map(clean.map(p => [p.u, dataOf(p)]));
        const ops = [];
        for (const p of clean) {
          const current = next.get(p.u);
          const old = knownRecords.get(p.u);
          if (!old || JSON.stringify(old) !== JSON.stringify(current)) {
            ops.push({ ref: recordsRef().doc(p.u), data: current });
          }
        }
        for (const id of knownRecords.keys()) {
          if (!next.has(id)) ops.push({ ref: recordsRef().doc(id), delete: true });
        }
        await commitOps(ops);
        knownRecords = next;
        setStatus("متصل — تم حفظ التعديلات");
      } catch (error) {
        setStatus("فشل الحفظ: " + (error.code || error.message || "خطأ غير معروف"));
        console.error("Firebase sync error", error);
      } finally { syncing = false; }
    }).catch(error => { syncing = false; console.error("Firebase sync queue error", error); });
    return syncQueue;
  }

  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("loginError").textContent = "";
    if (!configured) {
      $("loginError").textContent = "أكمل بيانات Firebase في js/firebase.js أولًا.";
      return;
    }
    try { await firebase.auth().signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPassword").value); }
    catch (error) { $("loginError").textContent = errText(error); }
  });
  $("logoutBtn").addEventListener("click", () => firebase.auth().signOut());
  window.clinicSyncSave = syncPatients;

  if (!configured || !window.firebase) {
    showApp(null); setStatus("Firebase غير مُعدّ"); return;
  }

  firebase.initializeApp(window.CLINIC_FIREBASE_CONFIG);
  db = firebase.firestore();
  firebase.auth().onAuthStateChanged(async user => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    showApp(user);
    if (!user) { setStatus("غير مسجل الدخول"); return; }
    setStatus("جاري تحميل السجلات…");
    try {
      const col = recordsRef();
      const snap = await col.get();
      if (snap.empty) {
        // أول مزامنة: نقل البيانات المحلية إلى مستند مستقل لكل مريض.
        let local = [];
        try { local = JSON.parse(localStorage.getItem("clinic_patients_v1") || "[]"); } catch (_) {}
        if (local.length) {
          setStatus("أول مزامنة — جاري رفع " + local.length + " سجلًا…");
          const clean = await writeFullCollection(local);
          try { localStorage.setItem("clinic_patients_v1", JSON.stringify(clean)); } catch (_) {}
        }
      } else {
        const remote = snap.docs.map(d => ({ ...d.data(), u: d.id }));
        knownRecords = new Map(remote.map(p => [p.u, dataOf(p)]));
        applyingRemote = true;
        if (window.clinicApplyRemotePatients) window.clinicApplyRemotePatients(remote);
        applyingRemote = false;
      }
      unsubscribe = col.onSnapshot(docSnap => {
        if (syncing) return;
        const remote = docSnap.docs.map(d => ({ ...d.data(), u: d.id }));
        const next = new Map(remote.map(p => [p.u, dataOf(p)]));
        knownRecords = next;
        applyingRemote = true;
        if (window.clinicApplyRemotePatients) window.clinicApplyRemotePatients(remote);
        applyingRemote = false;
        setStatus("متصل — البيانات متزامنة (" + remote.length + " سجل)");
      }, error => {
        applyingRemote = false;
        setStatus("فشل الاتصال: " + (error.code || error.message));
        console.error("Firestore listener error", error);
      });
      if (snap.empty) setStatus("متصل — تم رفع البيانات الأولية");
      else setStatus("متصل — البيانات متزامنة (" + snap.size + " سجل)");
    } catch (error) {
      applyingRemote = false;
      setStatus("تعذر تحميل/حفظ البيانات: " + (error.code || error.message));
      console.error("Firebase initial sync error", error);
    }
  });
})();
