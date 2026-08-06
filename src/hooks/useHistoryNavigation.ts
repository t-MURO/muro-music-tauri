import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

export const useHistoryNavigation = () => {
  const location = useLocation();
  const navigate = useNavigate();

  // Track history as array of keys and current index
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(0);
  const isNavigatingRef = useRef(false);

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    const key = location.key;

    if (isNavigatingRef.current) {
      // Navigation was triggered by our goBack/goForward
      isNavigatingRef.current = false;
      return;
    }

    // Check if this key exists in history (user used browser back/forward)
    const existingIndex = historyRef.current.indexOf(key);
    if (existingIndex !== -1) {
      indexRef.current = existingIndex;
    } else {
      // New navigation - truncate forward history and push
      historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
      historyRef.current.push(key);
      indexRef.current = historyRef.current.length - 1;
    }

    setCanGoBack(indexRef.current > 0);
    setCanGoForward(indexRef.current < historyRef.current.length - 1);
  }, [location.key]);

  const goBack = useCallback(() => {
    if (indexRef.current > 0) {
      isNavigatingRef.current = true;
      indexRef.current -= 1;
      setCanGoBack(indexRef.current > 0);
      setCanGoForward(true);
      navigate(-1);
    }
  }, [navigate]);

  const goForward = useCallback(() => {
    if (indexRef.current < historyRef.current.length - 1) {
      isNavigatingRef.current = true;
      indexRef.current += 1;
      setCanGoBack(true);
      setCanGoForward(indexRef.current < historyRef.current.length - 1);
      navigate(1);
    }
  }, [navigate]);

  return { canGoBack, canGoForward, goBack, goForward };
};
