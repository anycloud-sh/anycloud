export const suggestFilter = (
  input: string,
  choices: Array<{ title: string }>,
) => {
  const query = input.toLowerCase();
  return Promise.resolve(
    choices.filter((choice) => choice.title.toLowerCase().includes(query)),
  );
};
