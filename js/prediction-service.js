(function createPredictionService(global) {
  const STORAGE_KEY = "world-cup-prediction-demo-v1";
  const USER_KEY = "world-cup-prediction-user-v1";

  function makeId() {
    return global.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function readDemoData() {
    try {
      return JSON.parse(global.localStorage.getItem(STORAGE_KEY)) || { profiles: [], rooms: [], members: [], predictions: [] };
    } catch {
      return { profiles: [], rooms: [], members: [], predictions: [] };
    }
  }

  function writeDemoData(data) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function getLocalUserId() {
    let id = global.localStorage.getItem(USER_KEY);
    if (!id) {
      id = makeId();
      global.localStorage.setItem(USER_KEY, id);
    }
    return id;
  }

  function avatarText(nickname) {
    return Array.from(nickname.trim()).slice(-1)[0] || "球";
  }

  class DemoPredictionService {
    constructor() {
      this.mode = "demo";
      this.userId = getLocalUserId();
    }

    async getProfile() {
      return readDemoData().profiles.find((profile) => profile.id === this.userId) || null;
    }

    async ensureProfile(nickname) {
      const data = readDemoData();
      let profile = data.profiles.find((item) => item.id === this.userId);
      if (!profile && !nickname) return null;
      if (!profile) {
        profile = { id: this.userId, nickname: nickname.trim(), avatar_text: avatarText(nickname) };
        data.profiles.push(profile);
      } else if (nickname && profile.nickname !== nickname.trim()) {
        profile.nickname = nickname.trim();
        profile.avatar_text = avatarText(nickname);
      }
      writeDemoData(data);
      return profile;
    }

    async createRoom(payload) {
      const data = readDemoData();
      const room = {
        id: makeId(),
        code: Math.random().toString(36).slice(2, 8).toUpperCase(),
        creator_id: this.userId,
        match_id: payload.matchId,
        match_label: payload.matchLabel,
        status: "open",
        max_players: 20,
        created_at: new Date().toISOString(),
      };
      data.rooms.push(room);
      data.members.push({ room_id: room.id, user_id: this.userId, joined_at: room.created_at });
      data.predictions.push({
        room_id: room.id,
        user_id: this.userId,
        answers: payload.answers,
        points: 0,
        hits: 0,
        submitted_at: room.created_at,
      });
      writeDemoData(data);
      return this.getRoom(room.id);
    }

    async joinRoom(roomId) {
      const data = readDemoData();
      if (!data.rooms.some((room) => room.id === roomId)) throw new Error("预测房不存在或已失效");
      if (!data.members.some((member) => member.room_id === roomId && member.user_id === this.userId)) {
        data.members.push({ room_id: roomId, user_id: this.userId, joined_at: new Date().toISOString() });
        writeDemoData(data);
      }
      return this.getRoom(roomId);
    }

    async savePrediction(roomId, answers) {
      const data = readDemoData();
      const existing = data.predictions.find((item) => item.room_id === roomId && item.user_id === this.userId);
      if (existing) {
        existing.answers = answers;
        existing.submitted_at = new Date().toISOString();
      } else {
        data.predictions.push({ room_id: roomId, user_id: this.userId, answers, points: 0, hits: 0, submitted_at: new Date().toISOString() });
      }
      writeDemoData(data);
      return this.getRoom(roomId);
    }

    async getRoom(roomId) {
      const data = readDemoData();
      const room = data.rooms.find((item) => item.id === roomId);
      if (!room) throw new Error("预测房不存在或已失效");
      const members = data.members
        .filter((item) => item.room_id === roomId)
        .map((member) => data.profiles.find((profile) => profile.id === member.user_id))
        .filter(Boolean);
      const prediction = data.predictions.find((item) => item.room_id === roomId && item.user_id === this.userId) || null;
      return { room, members, prediction };
    }

    async getLeaderboard() {
      const data = readDemoData();
      return data.profiles.map((profile) => {
        const predictions = data.predictions.filter((item) => item.user_id === profile.id);
        return {
          user_id: profile.id,
          nickname: profile.nickname,
          avatar_text: profile.avatar_text,
          total_points: predictions.reduce((sum, item) => sum + (item.points || 0), 0),
          predictions_count: predictions.length,
          wins: 0,
        };
      }).sort((a, b) => b.total_points - a.total_points).slice(0, 20);
    }
  }

  class SupabasePredictionService {
    constructor(client) {
      this.mode = "cloud";
      this.client = client;
      this.userId = null;
    }

    async authenticate() {
      const { data: sessionData } = await this.client.auth.getSession();
      let user = sessionData.session?.user;
      if (!user) {
        const { data, error } = await this.client.auth.signInAnonymously();
        if (error) throw error;
        user = data.user;
      }
      this.userId = user.id;
      return user;
    }

    async getProfile() {
      await this.authenticate();
      const { data, error } = await this.client.from("profiles").select("id,nickname,avatar_text").eq("id", this.userId).maybeSingle();
      if (error) throw error;
      return data;
    }

    async ensureProfile(nickname) {
      await this.authenticate();
      const current = await this.getProfile();
      if (!current && !nickname) return null;
      if (current && !nickname) return current;
      const profile = { id: this.userId, nickname: nickname.trim(), avatar_text: avatarText(nickname) };
      const { data, error } = await this.client.from("profiles").upsert(profile).select("id,nickname,avatar_text").single();
      if (error) throw error;
      return data;
    }

    async createRoom(payload) {
      await this.authenticate();
      const { data: room, error: roomError } = await this.client.from("prediction_rooms").insert({
        creator_id: this.userId,
        match_id: payload.matchId,
        match_label: payload.matchLabel,
      }).select("*").single();
      if (roomError) throw roomError;
      const { error: memberError } = await this.client.from("room_members").insert({ room_id: room.id, user_id: this.userId });
      if (memberError) throw memberError;
      const { error: predictionError } = await this.client.from("predictions").insert({ room_id: room.id, user_id: this.userId, answers: payload.answers });
      if (predictionError) throw predictionError;
      return this.getRoom(room.id);
    }

    async joinRoom(roomId) {
      await this.authenticate();
      const { error } = await this.client.from("room_members").upsert({ room_id: roomId, user_id: this.userId }, { onConflict: "room_id,user_id" });
      if (error) throw error;
      return this.getRoom(roomId);
    }

    async savePrediction(roomId, answers) {
      await this.authenticate();
      const { error } = await this.client.from("predictions").upsert(
        { room_id: roomId, user_id: this.userId, answers, submitted_at: new Date().toISOString() },
        { onConflict: "room_id,user_id" },
      );
      if (error) throw error;
      return this.getRoom(roomId);
    }

    async getRoom(roomId) {
      await this.authenticate();
      const { data: room, error: roomError } = await this.client.from("prediction_rooms").select("*").eq("id", roomId).single();
      if (roomError) throw roomError;
      const { data: memberRows, error: memberError } = await this.client.from("room_members").select("user_id,joined_at").eq("room_id", roomId).order("joined_at");
      if (memberError) throw memberError;
      const ids = memberRows.map((item) => item.user_id);
      let members = [];
      if (ids.length) {
        const { data, error } = await this.client.from("profiles").select("id,nickname,avatar_text").in("id", ids);
        if (error) throw error;
        members = data;
      }
      const { data: prediction, error: predictionError } = await this.client.from("predictions").select("answers,points,hits,submitted_at").eq("room_id", roomId).eq("user_id", this.userId).maybeSingle();
      if (predictionError) throw predictionError;
      return { room, members, prediction };
    }

    async getLeaderboard() {
      const { data, error } = await this.client.rpc("get_prediction_leaderboard", { limit_count: 20 });
      if (error) throw error;
      return data;
    }
  }

  global.PredictionService = {
    create(config = {}) {
      const canUseCloud = config.supabaseUrl && config.supabaseAnonKey && global.supabase?.createClient;
      if (!canUseCloud) return new DemoPredictionService();
      return new SupabasePredictionService(global.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey));
    },
  };
})(window);
