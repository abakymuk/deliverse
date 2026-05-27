type FoodHallStubProps = {
  storefrontName: string;
};

export function FoodHallStub({ storefrontName }: FoodHallStubProps) {
  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold">{storefrontName}</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">
        Food hall — coming soon. Brand directory and unified cart in development.
      </p>
    </div>
  );
}
