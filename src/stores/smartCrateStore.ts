import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SmartCrate } from "../types";

type SmartCrateInput = Omit<SmartCrate, "id">;

type SmartCrateState = {
  smartCrates: SmartCrate[];
};

type SmartCrateActions = {
  createSmartCrate: (crate: SmartCrateInput) => string;
  updateSmartCrate: (id: string, updates: SmartCrateInput) => void;
  deleteSmartCrate: (id: string) => void;
};

export type SmartCrateStore = SmartCrateState & SmartCrateActions;

const createSmartCrateId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `smart-crate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const useSmartCrateStore = create<SmartCrateStore>()(
  persist(
    (set) => ({
      smartCrates: [],
      createSmartCrate: (crate) => {
        const id = createSmartCrateId();
        set((state) => ({ smartCrates: [...state.smartCrates, { ...crate, id }] }));
        return id;
      },
      updateSmartCrate: (id, updates) => set((state) => ({
        smartCrates: state.smartCrates.map((crate) =>
          crate.id === id ? { ...updates, id } : crate
        ),
      })),
      deleteSmartCrate: (id) => set((state) => ({
        smartCrates: state.smartCrates.filter((crate) => crate.id !== id),
      })),
    }),
    {
      name: "muro-smart-crates",
      partialize: (state) => ({ smartCrates: state.smartCrates }),
    }
  )
);
