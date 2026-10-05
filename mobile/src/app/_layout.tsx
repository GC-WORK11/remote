import React, { useEffect } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import { NavigationBar } from "expo-navigation-bar";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  Inter_900Black,
} from "@expo-google-fonts/inter";
import { RigProvider } from "../state";
import { RemoteDrawer } from "../components/drawer";
import { AuthSheet } from "../components/auth";
import { ScreenSheet } from "../components/sheet";
import { GlobalSheets } from "../components/sheets";

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function Root() {
  // Inter is bundled for Android — iOS renders the system face and never
  // consults these names, but loading them keeps the family's weight
  // resolution identical across platforms.
  const [fontsReady, fontErr] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    Inter_900Black,
  });
  useEffect(() => {
    if (fontsReady || fontErr) SplashScreen.hideAsync().catch(() => {});
  }, [fontsReady, fontErr]);
  if (!fontsReady && !fontErr) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <RigProvider>
          <View style={{ flex: 1 }}>
            {/* light theme + edge-to-edge: status icons go dark or they're
                white-on-white on Android; the nav bar below picks the light
                style so the system buttons draw dark on the canvas too */}
            <StatusBar style="dark" />
            <NavigationBar style="light" />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="home" />
              <Stack.Screen name="thread" />
              <Stack.Screen name="pr" />
              <Stack.Screen name="screen" />
              <Stack.Screen name="recordings" />
              {__DEV__ ? <Stack.Screen name="dev-thread" /> : null}
            </Stack>
            <RemoteDrawer />
            <AuthSheet />
            <ScreenSheet />
            <GlobalSheets />
          </View>
        </RigProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
